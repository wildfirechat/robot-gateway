package client

import (
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ConnectionManager manages the WebSocket connection lifecycle.
type ConnectionManager struct {
	gatewayURL        string
	messageHandler    MessageHandler
	client            *RobotGatewayClient
	
	// Connection state
	mu            sync.RWMutex
	running       int32
	connected     int32
	authenticated int32
	robotID       string
	robotSecret   string

	// 重连去重：同一时刻最多一个重连任务、一个重连定时器，
	// 避免断线处理被多次触发时开出多个并发 WebSocket
	// （并发 socket 互相抢鉴权，会触发服务端 "Already authenticated"
	// 并让自动重连被关闭，导致客户端永久假死）。
	reconnecting   int32
	reconnectTimer *time.Timer
	reconnectMu    sync.Mutex
	
	// Configuration
	reconnectInterval time.Duration
	heartbeatInterval time.Duration
	requestTimeout    time.Duration
	
	// Internal channels
	stopChan          chan struct{}
	heartbeatStopChan chan struct{}
}

// NewConnectionManager creates a new ConnectionManager.
func NewConnectionManager(gatewayURL string, handler MessageHandler) *ConnectionManager {
	return NewConnectionManagerWithConfig(gatewayURL, handler, 5*time.Second, 270*time.Second, 30*time.Second)
}

// NewConnectionManagerWithConfig creates a new ConnectionManager with custom configuration.
func NewConnectionManagerWithConfig(
	gatewayURL string,
	handler MessageHandler,
	reconnectInterval,
	heartbeatInterval,
	requestTimeout time.Duration,
) *ConnectionManager {
	cm := &ConnectionManager{
		gatewayURL:        gatewayURL,
		messageHandler:    handler,
		reconnectInterval: reconnectInterval,
		heartbeatInterval: heartbeatInterval,
		requestTimeout:    requestTimeout,
		stopChan:          make(chan struct{}),
		heartbeatStopChan: make(chan struct{}),
	}
	cm.client = NewRobotGatewayClient(gatewayURL, handler, cm)
	return cm
}

// Start starts the connection manager.
func (cm *ConnectionManager) Start() {
	if atomic.LoadInt32(&cm.running) == 1 {
		return
	}

	atomic.StoreInt32(&cm.running, 1)
	cm.startHeartbeat()
	cm.connect()
}

// Stop stops the connection manager (internal use).
func (cm *ConnectionManager) Stop() {
	if atomic.LoadInt32(&cm.running) == 0 {
		return
	}

	atomic.StoreInt32(&cm.running, 0)
	atomic.StoreInt32(&cm.authenticated, 0)
	cm.clearCredentials()

	cm.stopHeartbeat()

	// 清理重连定时器
	cm.reconnectMu.Lock()
	if cm.reconnectTimer != nil {
		cm.reconnectTimer.Stop()
		cm.reconnectTimer = nil
	}
	cm.reconnectMu.Unlock()

	cm.client.Close()
}

// stop is an alias for Stop for compatibility.
func (cm *ConnectionManager) stop() {
	cm.Stop()
}

// Connect connects and authenticates with the given credentials.
func (cm *ConnectionManager) Connect(robotID, secret string) bool {
	return cm.ConnectWithTimeout(robotID, secret, 30)
}

// ConnectWithTimeout connects with a specified timeout in seconds.
func (cm *ConnectionManager) ConnectWithTimeout(robotID, secret string, timeoutSeconds int64) bool {
	cm.Start()

	// Wait for connection
	startTime := time.Now()
	for !cm.IsConnected() && cm.IsRunning() {
		time.Sleep(100 * time.Millisecond)
		if time.Since(startTime) > time.Duration(timeoutSeconds)*time.Second {
			cm.Stop()
			return false
		}
	}

	// Send authentication request
	authResult := make(chan bool, 1)
	cm.client.SendConnect(robotID, secret, authResult)

	// Wait for authentication result
	// We need a mechanism to get the auth result
	// For now, poll the authenticated state
	startTime = time.Now()
	for time.Since(startTime) < time.Duration(timeoutSeconds)*time.Second {
		if cm.IsAuthenticated() {
			cm.mu.Lock()
			cm.robotID = robotID
			cm.robotSecret = secret
			cm.mu.Unlock()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Authentication failed or timeout
	cm.Stop()
	return false
}

// GetClient returns the WebSocket client.
func (cm *ConnectionManager) GetClient() *RobotGatewayClient {
	return cm.client
}

// IsConnected returns true if connected to the gateway.
func (cm *ConnectionManager) IsConnected() bool {
	return atomic.LoadInt32(&cm.connected) == 1 && cm.client.IsOpen()
}

// IsAuthenticated returns true if authenticated.
func (cm *ConnectionManager) IsAuthenticated() bool {
	return atomic.LoadInt32(&cm.authenticated) == 1
}

// IsRunning returns true if the manager is running.
func (cm *ConnectionManager) IsRunning() bool {
	return atomic.LoadInt32(&cm.running) == 1
}

// GetRobotID returns the current robot ID.
func (cm *ConnectionManager) GetRobotID() string {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	return cm.robotID
}

// GetLastHeartbeatTime returns the last heartbeat time.
func (cm *ConnectionManager) GetLastHeartbeatTime() int64 {
	// Return current time as we don't track actual heartbeat time
	return time.Now().UnixMilli()
}

// Internal methods

func (cm *ConnectionManager) connect() {
	if !cm.IsRunning() {
		return
	}

	if err := cm.client.Connect(); err != nil {
		cm.scheduleReconnect()
	}
}

func (cm *ConnectionManager) reconnect() {
	if !cm.IsRunning() {
		return
	}

	// 重连入口防重入：重连进行中忽略并发触发
	if !atomic.CompareAndSwapInt32(&cm.reconnecting, 0, 1) {
		return
	}
	defer atomic.StoreInt32(&cm.reconnecting, 0)

	if err := cm.client.Reconnect(); err != nil {
		// 重连失败后的再次调度同样走定时器去重
		cm.scheduleReconnect()
	}
}

func (cm *ConnectionManager) scheduleReconnect() {
	if !cm.IsRunning() {
		return
	}

	cm.reconnectMu.Lock()
	defer cm.reconnectMu.Unlock()

	// 定时器去重：多次触发只保留一个重连任务
	if cm.reconnectTimer != nil {
		return
	}

	cm.reconnectTimer = time.AfterFunc(cm.reconnectInterval, func() {
		cm.reconnectMu.Lock()
		cm.reconnectTimer = nil
		cm.reconnectMu.Unlock()

		if cm.IsRunning() && !cm.IsConnected() {
			cm.reconnect()
		}
	})
}

func (cm *ConnectionManager) onConnected() {
	atomic.StoreInt32(&cm.connected, 1)

	// Auto re-authenticate if we have credentials
	cm.mu.RLock()
	robotID := cm.robotID
	robotSecret := cm.robotSecret
	cm.mu.RUnlock()

	if robotID != "" && robotSecret != "" && !cm.IsAuthenticated() {
		go func() {
			authResult := make(chan bool, 1)
			cm.client.SendConnect(robotID, robotSecret, authResult)

			// Wait for auth with timeout
			select {
			case success := <-authResult:
				if !success {
					cm.clearCredentials()
				}
			case <-time.After(30 * time.Second):
				cm.clearCredentials()
			}
		}()
	}
}

func (cm *ConnectionManager) onAuthenticated() {
	atomic.StoreInt32(&cm.authenticated, 1)
	if cm.messageHandler != nil {
		cm.messageHandler.OnConnectionChanged(true)
	}
}

func (cm *ConnectionManager) onAuthenticationFailed(msg string) {
	// "Already authenticated" 是并发连接竞态的瞬态错误，不是真正的鉴权失败
	// （密钥错误）。瞬态错误绝不关闭自动重连，否则网关重启后客户端会永久
	// 假死。做法：保持自动重连开启，拆除当前连接并安排一次（去重后的）重连，
	// 等服务端清理掉旧的连接后再重新鉴权。
	if strings.Contains(msg, "Already authenticated") {
		atomic.StoreInt32(&cm.authenticated, 0)
		cm.client.Close()
		cm.scheduleReconnect()
		return
	}

	// 真正的鉴权失败（密钥错误等）：清除凭据并停止重连
	cm.clearCredentials()
	atomic.StoreInt32(&cm.authenticated, 0)
	atomic.StoreInt32(&cm.running, 0)
	cm.stopHeartbeat()

	if cm.messageHandler != nil {
		cm.messageHandler.OnConnectionChanged(false)
	}
}

func (cm *ConnectionManager) onDisconnected() {
	wasAuthenticated := cm.IsAuthenticated()
	atomic.StoreInt32(&cm.connected, 0)
	atomic.StoreInt32(&cm.authenticated, 0)

	if wasAuthenticated && cm.messageHandler != nil {
		cm.messageHandler.OnConnectionChanged(false)
	}

	// Reconnect if we have credentials
	cm.mu.RLock()
	hasCreds := cm.robotID != "" && cm.robotSecret != ""
	cm.mu.RUnlock()

	if cm.IsRunning() && hasCreds {
		cm.scheduleReconnect()
	}
}

func (cm *ConnectionManager) clearCredentials() {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	cm.robotID = ""
	cm.robotSecret = ""
}

func (cm *ConnectionManager) startHeartbeat() {
	go func() {
		ticker := time.NewTicker(cm.heartbeatInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				if cm.IsAuthenticated() && cm.client.IsOpen() {
					cm.sendHeartbeat()
				}
			case <-cm.heartbeatStopChan:
				return
			case <-cm.stopChan:
				return
			}
		}
	}()
}

func (cm *ConnectionManager) stopHeartbeat() {
	close(cm.heartbeatStopChan)
	cm.heartbeatStopChan = make(chan struct{})
}

func (cm *ConnectionManager) sendHeartbeat() {
	// Send heartbeat request
	params := []interface{}{
		map[string]interface{}{
			"type":      "heartbeat",
			"timestamp": time.Now().UnixMilli(),
		},
	}

	ch, err := cm.client.SendRequest("heartbeat", params)
	if err != nil {
		return
	}

	// Wait for response with timeout
	select {
	case <-ch:
		// Heartbeat successful
	case <-time.After(5 * time.Second):
		// Heartbeat timeout, trigger disconnect
		cm.onDisconnected()
	}
}

// send sends a raw JSON message (for internal use).
func (cm *ConnectionManager) send(data []byte) error {
	// This would be used for direct message sending
	return nil
}
