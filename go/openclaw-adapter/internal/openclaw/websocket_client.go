package openclaw

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/wildfirechat/openclaw-adapter/internal/config"
	"github.com/wildfirechat/openclaw-adapter/internal/session"
	"go.uber.org/zap"
)

// MessageHandler handles messages from Openclaw Gateway.
type MessageHandler interface {
	OnConnected()
	OnDisconnected(code int, reason string)
	OnResponse(response *OpenclawInMessage)
	OnTyping(typing *OpenclawInMessage)
	OnError(error string)
}

// WebSocketClient is a client for Openclaw Gateway.
type WebSocketClient struct {
	config              *config.OpenclawConfig
	messageHandler      MessageHandler
	sessionContextMgr   *session.ContextManager
	logger              *zap.Logger

	conn               *websocket.Conn
	mu                 sync.RWMutex
	isOpen             int32
	isAuthenticated    int32
	lastHeartbeatTime  int64

	// Channels
	sendChan           chan []byte
	stopChan           chan struct{}
	heartbeatStopChan  chan struct{}

	// Pending requests
	pendingRequests    map[string]*PendingRequest
	pendingMu          sync.RWMutex

	// Message context
	messageContexts    map[string]*MessageContext
	contextMu          sync.RWMutex
}

// PendingRequest represents a pending request.
type PendingRequest struct {
	Method    string
	SenderID  string
	ThreadID  string
	IsGroup   bool
	Timestamp int64
}

// MessageContext stores context for a message.
type MessageContext struct {
	SenderID  string
	ThreadID  string
	IsGroup   bool
	Timestamp int64
	LastText  string
}

// RefreshTimestamp updates the timestamp.
func (m *MessageContext) RefreshTimestamp() {
	m.Timestamp = time.Now().UnixMilli()
}

// NewWebSocketClient creates a new Openclaw WebSocket client.
func NewWebSocketClient(
	cfg *config.OpenclawConfig,
	handler MessageHandler,
	sessionMgr *session.ContextManager,
	logger *zap.Logger,
) *WebSocketClient {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}

	return &WebSocketClient{
		config:            cfg,
		messageHandler:    handler,
		sessionContextMgr: sessionMgr,
		logger:            logger,
		sendChan:          make(chan []byte, 100),
		stopChan:          make(chan struct{}),
		heartbeatStopChan: make(chan struct{}),
		pendingRequests:   make(map[string]*PendingRequest),
		messageContexts:   make(map[string]*MessageContext),
	}
}

// Connect connects to the Openclaw Gateway.
func (c *WebSocketClient) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isOpen == 1 {
		return fmt.Errorf("already connected")
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		EnableCompression: false,
	}

	conn, _, err := dialer.Dial(c.config.URL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.conn = conn
	atomic.StoreInt32(&c.isOpen, 1)

	// Start goroutines
	go c.readLoop()
	go c.writeLoop()

	c.logger.Info("Connected to Openclaw Gateway", zap.String("url", c.config.URL))
	return nil
}

// IsAuthenticated returns true if authenticated.
func (c *WebSocketClient) IsAuthenticated() bool {
	return atomic.LoadInt32(&c.isAuthenticated) == 1
}

// CloseConnection closes the connection.
func (c *WebSocketClient) CloseConnection() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isOpen == 0 {
		return
	}

	atomic.StoreInt32(&c.isOpen, 0)
	atomic.StoreInt32(&c.isAuthenticated, 0)
	close(c.stopChan)
	close(c.heartbeatStopChan)

	if c.conn != nil {
		c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		c.conn.Close()
		c.conn = nil
	}

	c.logger.Info("Disconnected from Openclaw Gateway")
}

// SendMessage sends a message to Openclaw Gateway.
func (c *WebSocketClient) SendMessage(message *OpenclawOutMessage, senderID string) error {
	if !c.IsAuthenticated() {
		return fmt.Errorf("not authenticated")
	}

	// Register session context
	if c.sessionContextMgr != nil && senderID != "" {
		threadID := message.Channel.ThreadID
		if threadID == "" {
			threadID = senderID
		}
		c.sessionContextMgr.RegisterSession(
			session.DefaultSessionKey,
			senderID,
			threadID,
			message.Channel.IsGroup,
		)
	}

	// Convert to chat.send format
	requestID := uuid.New().String()

	params := &ChatSendParams{
		SessionKey:     "main",
		Message:        message.Message.Text,
		IdempotencyKey: uuid.New().String(),
	}

	// Add attachments if media present
	if message.Message.MediaURL != "" {
		params.Attachments = []Attachment{
			{
				Type: message.Message.MediaType,
				URL:  message.Message.MediaURL,
			},
		}
	}

	req := &RequestMessage{
		Type:   "req",
		ID:     requestID,
		Method: "chat.send",
		Params: params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	// Record pending request
	c.pendingMu.Lock()
	c.pendingRequests[requestID] = &PendingRequest{
		Method:    "chat.send",
		SenderID:  senderID,
		ThreadID:  message.Channel.ThreadID,
		IsGroup:   message.Channel.IsGroup,
		Timestamp: time.Now().UnixMilli(),
	}
	c.pendingMu.Unlock()

	c.send(data)
	c.logger.Debug("Sent message to Openclaw",
		zap.String("text", message.Message.Text),
		zap.String("sender", senderID))

	return nil
}

func (c *WebSocketClient) send(data []byte) {
	select {
	case c.sendChan <- data:
	case <-time.After(5 * time.Second):
		c.logger.Warn("Send channel blocked")
	}
}

func (c *WebSocketClient) readLoop() {
	defer func() {
		c.CloseConnection()
	}()

	for {
		select {
		case <-c.stopChan:
			return
		default:
		}

		c.mu.RLock()
		conn := c.conn
		c.mu.RUnlock()

		if conn == nil {
			return
		}

		_, data, err := conn.ReadMessage()
		if err != nil {
			c.logger.Error("Read error", zap.Error(err))
			if c.messageHandler != nil {
				c.messageHandler.OnError(err.Error())
			}
			return
		}

		c.handleMessage(data)
	}
}

func (c *WebSocketClient) writeLoop() {
	ticker := time.NewTicker(c.config.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case data := <-c.sendChan:
			c.mu.RLock()
			conn := c.conn
			c.mu.RUnlock()

			if conn != nil {
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					c.logger.Error("Write error", zap.Error(err))
				}
			}

		case <-ticker.C:
			if c.IsAuthenticated() {
				c.sendPing()
			}
			c.cleanupExpiredContexts()

		case <-c.heartbeatStopChan:
			return
		case <-c.stopChan:
			return
		}
	}
}

func (c *WebSocketClient) handleMessage(data []byte) {
	// Debug: print raw message
	c.logger.Debug("Received raw message", zap.String("data", string(data)))

	var jsonMsg map[string]interface{}
	if err := json.Unmarshal(data, &jsonMsg); err != nil {
		c.logger.Error("Failed to parse message", zap.Error(err))
		return
	}

	msgType, _ := jsonMsg["type"].(string)

	switch msgType {
	case "event":
		c.handleEvent(data, jsonMsg)
	case "res":
		c.handleResponse(data, jsonMsg)
	default:
		// Try to parse as regular message
		var msg OpenclawInMessage
		if err := json.Unmarshal(data, &msg); err == nil {
			c.handleOpenclawMessage(&msg)
		}
	}
}

func (c *WebSocketClient) handleEvent(data []byte, jsonMsg map[string]interface{}) {
	eventType, _ := jsonMsg["event"].(string)

	switch eventType {
	case "connect.challenge":
		c.handleChallenge()
	case "agent":
		c.handleAgentEvent(jsonMsg)
	case "chat":
		c.handleChatEvent(jsonMsg)
	}
}

func (c *WebSocketClient) handleResponse(data []byte, jsonMsg map[string]interface{}) {
	requestID, _ := jsonMsg["id"].(string)
	ok, _ := jsonMsg["ok"].(bool)

	c.pendingMu.Lock()
	pending := c.pendingRequests[requestID]
	c.pendingMu.Unlock()

	if pending == nil {
		return
	}

	if pending.Method == "connect" {
		c.pendingMu.Lock()
		delete(c.pendingRequests, requestID)
		c.pendingMu.Unlock()

		if ok {
			atomic.StoreInt32(&c.isAuthenticated, 1)
			c.logger.Info("Authenticated with Openclaw Gateway")
			if c.messageHandler != nil {
				c.messageHandler.OnConnected()
			}
		} else {
			c.logger.Error("Authentication failed")
			if c.messageHandler != nil {
				c.messageHandler.OnError("Authentication failed")
			}
		}
	} else if pending.Method == "chat.send" {
		c.pendingMu.Lock()
		delete(c.pendingRequests, requestID)
		c.pendingMu.Unlock()

		// Extract runId from response
		if payload, ok := jsonMsg["payload"].(map[string]interface{}); ok {
			if runID, ok := payload["runId"].(string); ok {
				c.contextMu.Lock()
				c.messageContexts[runID] = &MessageContext{
					SenderID:  pending.SenderID,
					ThreadID:  pending.ThreadID,
					IsGroup:   pending.IsGroup,
					Timestamp: time.Now().UnixMilli(),
				}
				c.contextMu.Unlock()

				// Register with session manager
				if c.sessionContextMgr != nil {
					c.sessionContextMgr.AssociateRunID(runID, session.DefaultSessionKey)
				}
			}
		}
	}
}

func (c *WebSocketClient) handleOpenclawMessage(msg *OpenclawInMessage) {
	if msg.Type == "" {
		return
	}

	switch msg.Type {
	case "response":
		if c.messageHandler != nil {
			c.messageHandler.OnResponse(msg)
		}
	case "typing":
		if c.messageHandler != nil {
			c.messageHandler.OnTyping(msg)
		}
	case "error":
		c.logger.Error("Openclaw error", zap.String("error", msg.Error))
		if c.messageHandler != nil {
			c.messageHandler.OnError(msg.Error)
		}
	}
}

func (c *WebSocketClient) handleChallenge() {
	c.logger.Info("Received connect challenge")
	c.sendConnectRequest()
}

func (c *WebSocketClient) sendConnectRequest() {
	requestID := uuid.New().String()

	params := &ConnectParams{
		MinProtocol: 3,
		MaxProtocol: 3,
		Client: &ClientInfo{
			ID:       "cli",
			Version:  "1.0.0",
			Platform: "go",
			Mode:     "cli",
		},
		Role:      "operator",
		Scopes:    []string{"operator.read", "operator.write"},
		UserAgent: "openclaw-adapter/1.0.0",
	}

	if c.config.Token != "" {
		params.Auth = &AuthInfo{
			Token: c.config.Token,
		}
	}

	req := &RequestMessage{
		Type:   "req",
		ID:     requestID,
		Method: "connect",
		Params: params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		c.logger.Error("Failed to marshal connect request", zap.Error(err))
		return
	}

	// Debug: print the JSON being sent
	c.logger.Debug("Connect request JSON", zap.String("json", string(data)))

	c.pendingMu.Lock()
	c.pendingRequests[requestID] = &PendingRequest{
		Method:    "connect",
		Timestamp: time.Now().UnixMilli(),
	}
	c.pendingMu.Unlock()

	c.send(data)
	c.logger.Info("Sent connect request")
}

func (c *WebSocketClient) handleAgentEvent(jsonMsg map[string]interface{}) {
	// Handle agent events (streaming responses)
	payload, ok := jsonMsg["payload"].(map[string]interface{})
	if !ok {
		return
	}

	runID, _ := payload["runId"].(string)
	stream, _ := payload["stream"].(string)

	if runID == "" {
		return
	}

	// Get context
	c.contextMu.RLock()
	context := c.messageContexts[runID]
	c.contextMu.RUnlock()

	if context == nil && c.sessionContextMgr != nil {
		// Try to get from session manager
		sessionCtx := c.sessionContextMgr.GetContextByRunID(runID)
		if sessionCtx == nil {
			sessionCtx = c.sessionContextMgr.GetDefaultSessionContext()
		}
		if sessionCtx != nil {
			context = &MessageContext{
				SenderID:  sessionCtx.SenderID,
				ThreadID:  sessionCtx.ThreadID,
				IsGroup:   sessionCtx.IsGroup,
				Timestamp: time.Now().UnixMilli(),
			}
			c.contextMu.Lock()
			c.messageContexts[runID] = context
			c.contextMu.Unlock()
		}
	}

	if context == nil {
		return
	}

	// Extract text from data
	var text string
	var state string

	if data, ok := payload["data"].(map[string]interface{}); ok {
		if t, ok := data["text"].(string); ok {
			text = t
		}
		if phase, ok := data["phase"].(string); ok {
			if phase == "start" {
				state = "start"
			} else if phase == "end" {
				state = "completed"
			}
		}
	}

	if stream == "assistant" && state == "" {
		state = "generating"
	}

	if text != "" {
		context.LastText = text
	}

	// For completed state, if text is empty, use lastText from context
	// This matches Java version behavior
	if state == "completed" && text == "" && context.LastText != "" {
		text = context.LastText
	}

	// Create response message
	response := &OpenclawInMessage{
		Type: "streaming",
		Channel: &OpenclawChannel{
			PeerID:   context.SenderID,
			ThreadID: context.ThreadID,
			IsGroup:  context.IsGroup,
		},
		Message: &OpenclawMessage{
			Text: text,
			Extra: map[string]interface{}{
				"streamId": runID,
				"state":    state,
			},
		},
	}

	if c.messageHandler != nil {
		c.messageHandler.OnResponse(response)
	}

	if state == "completed" {
		c.contextMu.Lock()
		delete(c.messageContexts, runID)
		c.contextMu.Unlock()
	}
}

func (c *WebSocketClient) handleChatEvent(jsonMsg map[string]interface{}) {
	// Handle chat events
	payload, ok := jsonMsg["payload"].(map[string]interface{})
	if !ok {
		return
	}

	runID, _ := payload["runId"].(string)
	state, _ := payload["state"].(string)

	if state == "final" || state == "error" {
		c.contextMu.Lock()
		delete(c.messageContexts, runID)
		c.contextMu.Unlock()
	}
}

func (c *WebSocketClient) sendPing() {
	c.mu.RLock()
	conn := c.conn
	c.mu.RUnlock()

	if conn != nil {
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			c.logger.Error("Ping error", zap.Error(err))
		}
	}
	atomic.StoreInt64(&c.lastHeartbeatTime, time.Now().UnixMilli())
}

func (c *WebSocketClient) cleanupExpiredContexts() {
	now := time.Now().UnixMilli()
	timeout := int64(5 * 60 * 1000) // 5 minutes

	c.contextMu.Lock()
	defer c.contextMu.Unlock()

	for id, ctx := range c.messageContexts {
		if now-ctx.Timestamp > timeout {
			delete(c.messageContexts, id)
		}
	}
}
