package client

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/wildfirechat/robot-gateway-sdk/protocol"
)

// RobotGatewayClient is a WebSocket client for the robot gateway.
type RobotGatewayClient struct {
	gatewayURL      string
	headers         http.Header
	messageHandler  MessageHandler
	connManager     *ConnectionManager
	responseHandler *ResponseHandler

	conn   *websocket.Conn
	mu     sync.RWMutex
	isOpen int32
	isAuth int32

	// Channel for sending messages
	sendChan chan []byte
	stopChan chan struct{}
	
	// Auth future
	authFuture chan bool
	authMu     sync.Mutex
}

// NewRobotGatewayClient creates a new RobotGatewayClient.
func NewRobotGatewayClient(gatewayURL string, handler MessageHandler, connManager *ConnectionManager) *RobotGatewayClient {
	if handler == nil {
		handler = &DefaultMessageHandler{}
	}

	return &RobotGatewayClient{
		gatewayURL:      gatewayURL,
		messageHandler:  handler,
		connManager:     connManager,
		responseHandler: NewResponseHandler(),
		sendChan:        make(chan []byte, 100),
		stopChan:        make(chan struct{}),
		authFuture:      make(chan bool, 1),
	}
}

// Connect establishes a WebSocket connection.
func (c *RobotGatewayClient) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isOpen == 1 {
		return fmt.Errorf("already connected")
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(c.gatewayURL, c.headers)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.conn = conn
	atomic.StoreInt32(&c.isOpen, 1)

	// Start goroutines for reading and writing
	go c.readLoop()
	go c.writeLoop()

	// Notify connection manager
	if c.connManager != nil {
		c.connManager.onConnected()
	}

	return nil
}

// Reconnect reconnects to the gateway.
func (c *RobotGatewayClient) Reconnect() error {
	c.Close()
	time.Sleep(100 * time.Millisecond)
	return c.Connect()
}

// IsOpen returns true if the connection is open.
func (c *RobotGatewayClient) IsOpen() bool {
	return atomic.LoadInt32(&c.isOpen) == 1
}

// IsAuthenticated returns true if the client is authenticated.
func (c *RobotGatewayClient) IsAuthenticated() bool {
	return atomic.LoadInt32(&c.isAuth) == 1
}

// setAuthenticated sets the authenticated state.
func (c *RobotGatewayClient) setAuthenticated(auth bool) {
	if auth {
		atomic.StoreInt32(&c.isAuth, 1)
	} else {
		atomic.StoreInt32(&c.isAuth, 0)
	}
}

// SendConnect sends an authentication request.
func (c *RobotGatewayClient) SendConnect(robotID, secret string, resultChan chan<- bool) {
	// Store the result channel (convert bidirectional channel)
	c.authMu.Lock()
	// Clear any pending auth result
	select {
	case <-c.authFuture:
	default:
	}
	// Create a new bidirectional channel and forward results
	newChan := make(chan bool, 1)
	c.authFuture = newChan
	c.authMu.Unlock()
	
	// Forward results to the provided channel
	go func() {
		result := <-newChan
		select {
		case resultChan <- result:
		default:
		}
	}()

	msg := protocol.NewConnectRequest(robotID, secret)
	data, err := json.Marshal(msg)
	if err != nil {
		select {
		case resultChan <- false:
		default:
		}
		return
	}

	c.send(data)
}

// SendRequest sends a request and returns a channel to receive the response.
func (c *RobotGatewayClient) SendRequest(method string, params []interface{}) (<-chan *protocol.ResponseMessage, error) {
	if !c.IsAuthenticated() {
		return nil, fmt.Errorf("not authenticated")
	}

	requestID := uuid.New().String()
	req := &protocol.RequestMessage{
		RequestID: requestID,
		Method:    method,
		Params:    params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	ch := c.responseHandler.RegisterRequest(requestID)
	c.send(data)

	return ch, nil
}

// send sends data through the WebSocket.
func (c *RobotGatewayClient) send(data []byte) {
	select {
	case c.sendChan <- data:
	case <-time.After(5 * time.Second):
		// Channel full or blocked
	}
}

// readLoop reads messages from the WebSocket.
func (c *RobotGatewayClient) readLoop() {
	defer func() {
		c.Close()
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
			if c.messageHandler != nil {
				c.messageHandler.OnError(err.Error())
			}
			return
		}

		c.handleMessage(data)
	}
}

// writeLoop writes messages to the WebSocket.
func (c *RobotGatewayClient) writeLoop() {
	ticker := time.NewTicker(30 * time.Second)
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
					// Write error
				}
			}

		case <-ticker.C:
			// Send ping
			c.mu.RLock()
			conn := c.conn
			c.mu.RUnlock()

			if conn != nil {
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					// Ping error
				}
			}

		case <-c.stopChan:
			return
		}
	}
}

// handleMessage handles incoming messages.
func (c *RobotGatewayClient) handleMessage(data []byte) {
	// Try to parse as ConnectMessage first
	var connMsg protocol.ConnectMessage
	if err := json.Unmarshal(data, &connMsg); err == nil && connMsg.Type == "connect" && connMsg.Code != nil {
		c.handleConnectResponse(&connMsg)
		return
	}

	// Try to parse as ResponseMessage
	var respMsg protocol.ResponseMessage
	if err := json.Unmarshal(data, &respMsg); err == nil && respMsg.RequestID != "" {
		c.responseHandler.HandleResponse(&respMsg)
		return
	}

	// Try to parse as PushMessage
	var pushMsg protocol.PushMessage
	if err := json.Unmarshal(data, &pushMsg); err == nil && (pushMsg.Type == "message" || pushMsg.Type == "event") {
		if c.messageHandler != nil {
			c.messageHandler.OnMessage(&pushMsg)
		}
		return
	}
}

// handleConnectResponse handles authentication response.
func (c *RobotGatewayClient) handleConnectResponse(msg *protocol.ConnectMessage) {
	c.authMu.Lock()
	authChan := c.authFuture
	c.authMu.Unlock()

	if msg.IsSuccess() {
		c.setAuthenticated(true)
		if c.connManager != nil {
			c.connManager.onAuthenticated()
		}
		select {
		case authChan <- true:
		default:
		}
	} else {
		c.setAuthenticated(false)
		if c.connManager != nil {
			c.connManager.onAuthenticationFailed()
		}
		select {
		case authChan <- false:
		default:
		}
	}
}

// Close closes the WebSocket connection.
func (c *RobotGatewayClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isOpen == 0 {
		return
	}

	atomic.StoreInt32(&c.isOpen, 0)
	c.responseHandler.Clear()

	// Signal close
	close(c.stopChan)

	if c.conn != nil {
		c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		c.conn.Close()
		c.conn = nil
	}

	if c.connManager != nil {
		c.connManager.onDisconnected()
	}

	// Reset channels
	c.stopChan = make(chan struct{})
}
