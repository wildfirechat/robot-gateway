package bridge

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wildfirechat/openclaw-adapter/internal/config"
	"github.com/wildfirechat/openclaw-adapter/internal/converter"
	"github.com/wildfirechat/openclaw-adapter/internal/filter"
	"github.com/wildfirechat/openclaw-adapter/internal/openclaw"
	"github.com/wildfirechat/openclaw-adapter/internal/session"
	"github.com/wildfirechat/robot-gateway-sdk/client"
	"github.com/wildfirechat/robot-gateway-sdk/protocol"
	"go.uber.org/zap"
)

// Bridge bridges Wildfire IM and Openclaw Gateway.
type Bridge struct {
	config            *config.Config
	logger            *zap.Logger

	// Components
	wildfireClient    *client.RobotServiceClient
	openclawClient    *openclaw.WebSocketClient
	messageConverter  *converter.MessageConverter
	groupFilter       *filter.GroupFilter
	whitelistFilter   *filter.WhitelistFilter
	sessionContextMgr *session.ContextManager

	// State
	mu                sync.RWMutex
	running           int32
	isReconnecting    int32
}

// NewBridge creates a new Bridge.
func NewBridge(cfg *config.Config, logger *zap.Logger) *Bridge {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}

	sessionMgr := session.NewContextManager()

	return &Bridge{
		config:            cfg,
		logger:            logger,
		sessionContextMgr: sessionMgr,
		messageConverter:  converter.NewMessageConverter(logger),
		groupFilter:       filter.NewGroupFilter(&cfg.Group, logger),
		whitelistFilter:   filter.NewWhitelistFilter(&cfg.Whitelist, logger),
	}
}

// Start starts the bridge.
func (b *Bridge) Start(ctx context.Context) error {
	if atomic.LoadInt32(&b.running) == 1 {
		return fmt.Errorf("bridge already running")
	}

	atomic.StoreInt32(&b.running, 1)

	// 1. Connect to Wildfire Gateway
	b.logger.Info("Connecting to Wildfire Gateway", zap.String("url", b.config.Wildfire.GatewayURL))

	messageHandler := &bridgeMessageHandler{bridge: b}
	b.wildfireClient = client.NewRobotServiceClient(
		b.config.Wildfire.GatewayURL,
		messageHandler,
	)

	connected := b.wildfireClient.Connect(b.config.Wildfire.RobotID, b.config.Wildfire.RobotSecret)
	if !connected {
		atomic.StoreInt32(&b.running, 0)
		return fmt.Errorf("failed to connect to Wildfire Gateway")
	}

	b.logger.Info("Connected to Wildfire Gateway",
		zap.String("robotId", b.wildfireClient.GetRobotID()))

	// 2. Connect to Openclaw Gateway
	b.logger.Info("Connecting to Openclaw Gateway", zap.String("url", b.config.Openclaw.URL))

	openclawHandler := &openclawMessageHandler{bridge: b}
	b.openclawClient = openclaw.NewWebSocketClient(
		&b.config.Openclaw,
		openclawHandler,
		b.sessionContextMgr,
		b.logger,
	)

	if err := b.openclawClient.Connect(); err != nil {
		b.wildfireClient.Close()
		atomic.StoreInt32(&b.running, 0)
		return fmt.Errorf("failed to connect to Openclaw Gateway: %w", err)
	}

	// Wait for authentication
	maxWait := 100 // 10 seconds
	waitCount := 0
	for !b.openclawClient.IsAuthenticated() && waitCount < maxWait {
		select {
		case <-ctx.Done():
			b.Stop()
			return ctx.Err()
		default:
			time.Sleep(100 * time.Millisecond)
			waitCount++
		}
	}

	if !b.openclawClient.IsAuthenticated() {
		b.Stop()
		return fmt.Errorf("failed to authenticate with Openclaw Gateway within timeout")
	}

	b.logger.Info("Openclaw Bridge started successfully")
	return nil
}

// Stop stops the bridge.
func (b *Bridge) Stop() {
	if atomic.LoadInt32(&b.running) == 0 {
		return
	}

	atomic.StoreInt32(&b.running, 0)

	if b.wildfireClient != nil {
		b.wildfireClient.Close()
	}

	if b.openclawClient != nil {
		b.openclawClient.CloseConnection()
	}

	b.logger.Info("Openclaw Bridge stopped")
}

// IsRunning returns true if the bridge is running.
func (b *Bridge) IsRunning() bool {
	return atomic.LoadInt32(&b.running) == 1
}

// IsWildfireConnected returns true if connected to Wildfire.
func (b *Bridge) IsWildfireConnected() bool {
	return b.wildfireClient != nil && b.wildfireClient.IsConnected()
}

// IsOpenclawConnected returns true if connected to Openclaw.
func (b *Bridge) IsOpenclawConnected() bool {
	return b.openclawClient != nil && b.openclawClient.IsAuthenticated()
}

// HandleWildfireMessage handles messages from Wildfire.
func (b *Bridge) HandleWildfireMessage(msg *protocol.PushMessage) {
	if !b.IsRunning() {
		b.logger.Warn("Bridge not running, ignoring message")
		return
	}

	if msg == nil || msg.Data == nil || msg.Data.Payload == nil {
		return
	}

	// Filter unsupported message types
	msgType := msg.Data.Payload.Type
	if msgType <= 0 || (msgType > 15 && msgType < 100) || msgType > 200 {
		b.logger.Debug("Ignoring unsupported message type", zap.Int("type", msgType))
		return
	}

	b.logger.Info("Received message from Wildfire",
		zap.String("sender", msg.Data.Sender),
		zap.Int("convType", msg.Data.Conv.Type))

	// 1. Whitelist filter
	senderID := msg.Data.Sender
	targetID := ""
	isGroup := false
	if msg.Data.Conv != nil {
		targetID = msg.Data.Conv.Target
		isGroup = msg.Data.Conv.Type == 1 || msg.Data.Conv.Type == 2
	}

	if !b.whitelistFilter.ShouldProcess(senderID, targetID, isGroup) {
		b.logger.Info("Message blocked by whitelist filter",
			zap.String("sender", senderID),
			zap.String("target", targetID))
		return
	}

	// 2. Convert to Openclaw format
	openclawMsg := b.messageConverter.ConvertToOpenclaw(msg)
	if openclawMsg == nil {
		b.logger.Debug("Failed to convert message")
		return
	}

	// 3. Group filter
	if !b.groupFilter.ShouldRespond(openclawMsg, b.wildfireClient.GetRobotID()) {
		b.logger.Debug("Message blocked by group filter")
		return
	}

	// 4. Send to Openclaw
	if senderID == "" {
		b.logger.Warn("Sender ID is empty, skipping")
		return
	}

	if err := b.openclawClient.SendMessage(openclawMsg, senderID); err != nil {
		b.logger.Error("Failed to send message to Openclaw", zap.Error(err))
	}
}

// HandleOpenclawResponse handles responses from Openclaw.
func (b *Bridge) HandleOpenclawResponse(response *openclaw.OpenclawInMessage) {
	if !b.IsRunning() {
		b.logger.Warn("Bridge not running, ignoring response")
		return
	}

	if response == nil || response.Message == nil {
		return
	}

	text := response.Message.Text
	if len(text) > 50 {
		text = text[:50] + "..."
	}
	b.logger.Info("Received response from Openclaw", zap.String("text", text))

	// 1. Convert to Wildfire format
	wfMessage := b.messageConverter.ConvertFromOpenclaw(response)
	if wfMessage == nil {
		b.logger.Error("Failed to convert Openclaw response")
		return
	}

	// 2. Send to Wildfire
	result, err := b.wildfireClient.SendMessage(wfMessage.Conversation, wfMessage.Payload)
	if err != nil {
		b.logger.Error("Failed to send message to Wildfire", zap.Error(err))
		return
	}

	if result.IsSuccess() {
		b.logger.Info("Successfully sent message to Wildfire",
			zap.String("target", wfMessage.TargetUserID))
	} else {
		b.logger.Error("Failed to send message to Wildfire",
			zap.Int("code", result.Code),
			zap.String("msg", result.Msg))
	}
}

// HandleOpenclawDisconnected handles Openclaw disconnection.
func (b *Bridge) HandleOpenclawDisconnected(code int, reason string) {
	b.logger.Warn("Disconnected from Openclaw Gateway",
		zap.Int("code", code),
		zap.String("reason", reason))

	if b.IsRunning() {
		b.scheduleOpenclawReconnect()
	}
}

// scheduleOpenclawReconnect schedules a reconnection to Openclaw.
func (b *Bridge) scheduleOpenclawReconnect() {
	if atomic.CompareAndSwapInt32(&b.isReconnecting, 0, 1) {
		defer atomic.StoreInt32(&b.isReconnecting, 0)
	} else {
		b.logger.Debug("Already reconnecting to Openclaw, skipping")
		return
	}

	go func() {
		retryCount := 0
		maxRetries := 10
		retryInterval := b.config.Openclaw.ReconnectInterval

		for b.IsRunning() && retryCount < maxRetries && !b.IsOpenclawConnected() {
			retryCount++
			b.logger.Info("Reconnecting to Openclaw Gateway",
				zap.Int("attempt", retryCount),
				zap.Int("maxRetries", maxRetries))

			newClient := openclaw.NewWebSocketClient(
				&b.config.Openclaw,
				&openclawMessageHandler{bridge: b},
				b.sessionContextMgr,
				b.logger,
			)

			if err := newClient.Connect(); err != nil {
				b.logger.Error("Reconnection attempt failed",
					zap.Int("attempt", retryCount),
					zap.Error(err))
			} else {
				// Wait for authentication
				maxWait := 50
				waitCount := 0
				for !newClient.IsAuthenticated() && waitCount < maxWait {
					time.Sleep(100 * time.Millisecond)
					waitCount++
				}

				if newClient.IsAuthenticated() {
					b.mu.Lock()
					b.openclawClient = newClient
					b.mu.Unlock()
					b.logger.Info("Successfully reconnected to Openclaw Gateway")
					return
				}
			}

			if retryCount < maxRetries && !b.IsOpenclawConnected() {
				time.Sleep(retryInterval)
			}
		}

		if !b.IsOpenclawConnected() {
			b.logger.Error("Failed to reconnect to Openclaw Gateway after max retries")
		}
	}()
}

// bridgeMessageHandler handles messages from Wildfire.
type bridgeMessageHandler struct {
	bridge *Bridge
}

func (h *bridgeMessageHandler) OnMessage(message *protocol.PushMessage) {
	h.bridge.HandleWildfireMessage(message)
}

func (h *bridgeMessageHandler) OnConnectionChanged(connected bool) {
	h.bridge.logger.Info("Wildfire connection changed", zap.Bool("connected", connected))
	if !connected {
		h.bridge.logger.Warn("Wildfire connection lost, SDK will auto-reconnect")
	}
}

func (h *bridgeMessageHandler) OnError(error string) {
	h.bridge.logger.Error("Wildfire error", zap.String("error", error))
}

// openclawMessageHandler handles messages from Openclaw.
type openclawMessageHandler struct {
	bridge *Bridge
}

func (h *openclawMessageHandler) OnConnected() {
	h.bridge.logger.Info("Connected to Openclaw Gateway")
}

func (h *openclawMessageHandler) OnDisconnected(code int, reason string) {
	h.bridge.HandleOpenclawDisconnected(code, reason)
}

func (h *openclawMessageHandler) OnResponse(response *openclaw.OpenclawInMessage) {
	h.bridge.HandleOpenclawResponse(response)
}

func (h *openclawMessageHandler) OnTyping(typing *openclaw.OpenclawInMessage) {
	h.bridge.logger.Debug("Openclaw is typing...")
}

func (h *openclawMessageHandler) OnError(error string) {
	h.bridge.logger.Error("Openclaw error", zap.String("error", error))
}
