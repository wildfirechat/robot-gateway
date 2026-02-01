package cn.wildfirechat.client;

import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.ResponseMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.HashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 连接管理器
 * 管理WebSocket连接的生命周期，支持鉴权
 */
class ConnectionManager {
    private static final Logger LOG = LoggerFactory.getLogger(ConnectionManager.class);

    private final RobotGatewayClient client;
    private final MessageHandler messageHandler;
    private final String gatewayUrl;
    private final long reconnectInterval;
    private final long heartbeatInterval;

    private volatile boolean running = false;
    private volatile boolean connected = false;
    private volatile boolean authenticated = false;
    private volatile String robotId;
    private volatile String robotSecret;

    private ScheduledExecutorService heartbeatExecutor;
    private volatile long lastHeartbeatTime;

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler) {
        this(gatewayUrl, messageHandler, 5000, 270000); // 默认5秒重连，270秒(4.5分钟)心跳
    }

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler, long reconnectInterval) {
        this(gatewayUrl, messageHandler, reconnectInterval, 270000); // 默认270秒心跳
    }

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler, long reconnectInterval, long heartbeatInterval) {
        this.gatewayUrl = gatewayUrl;
        this.messageHandler = messageHandler;
        this.reconnectInterval = reconnectInterval;
        this.heartbeatInterval = heartbeatInterval;
        this.client = new RobotGatewayClient(gatewayUrl, messageHandler, this);
    }

    /**
     * 启动连接
     */
    public void start() {
        if (running) {
            LOG.warn("Connection manager already running");
            return;
        }

        running = true;

        // 启动心跳线程
        startHeartbeat();

        connect();
    }

    /**
     * 连接并鉴权
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @return 鉴权是否成功
     */
    public boolean connect(String robotId, String secret) {
        return connect(robotId, secret, 30); // 默认30秒超时
    }

    /**
     * 连接并鉴权
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @param timeoutSeconds 超时时间（秒）
     * @return 鉴权是否成功
     */
    public boolean connect(String robotId, String secret, long timeoutSeconds) {
        // 先建立WebSocket连接
        start();

        // 等待连接建立
        long startTime = System.currentTimeMillis();
        while (!connected && running) {
            try {
                Thread.sleep(100);
                if (System.currentTimeMillis() - startTime > timeoutSeconds * 1000) {
                    LOG.error("Connection timeout");
                    stop();
                    return false;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                stop();
                return false;
            }
        }

        // 发送鉴权请求
        CompletableFuture<Boolean> authFuture = new CompletableFuture<>();

        // 注意：这里暂时不保存robotId和robotSecret
        // 只有鉴权成功后才保存，避免首次鉴权失败触发重连
        client.sendConnect(robotId, secret, authFuture);

        try {
            boolean result = authFuture.get(timeoutSeconds, TimeUnit.SECONDS);
            if (result) {
                // 鉴权成功，保存鉴权信息
                this.robotId = robotId;
                this.robotSecret = secret;
                LOG.info("Authentication successful, credentials saved for reconnect");
            } else {
                // 鉴权失败，不保存鉴权信息，避免重连
                LOG.warn("Authentication failed, credentials not saved");
                stop(); // 鉴权失败，停止连接
            }
            return result;
        } catch (Exception e) {
            LOG.error("Authentication failed: {}", e.getMessage());
            // 鉴权异常，不保存鉴权信息
            stop();
            return false;
        }
    }

    /**
     * 停止连接
     */
    public void stop() {
        running = false;
        authenticated = false;
        robotId = null;
        robotSecret = null;

        // 停止心跳
        stopHeartbeat();

        if (client.isOpen()) {
            client.close();
        }
    }

    /**
     * 连接到网关（内部使用）
     */
    private void connect() {
        if (!running) {
            return;
        }

        try {
            LOG.info("Connecting to gateway: {}", gatewayUrl);
            client.connect();
        } catch (Exception e) {
            LOG.error("Failed to connect: {}", e.getMessage());
            scheduleReconnect();
        }
    }

    /**
     * 重连接到网关（内部使用）
     */
    private void reconnect() {
        if (!running) {
            return;
        }

        try {
            LOG.info("Reconnecting to gateway: {}", gatewayUrl);
            client.reconnect();
        } catch (Exception e) {
            LOG.error("Failed to reconnect: {}", e.getMessage());
            scheduleReconnect();
        }
    }

    /**
     * 安排重连
     */
    private void scheduleReconnect() {
        if (!running) {
            return;
        }

        LOG.info("Scheduling reconnect in {} ms", reconnectInterval);
        new Thread(() -> {
            try {
                Thread.sleep(reconnectInterval);
                if (running && !connected) {
                    reconnect();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "ReconnectThread").start();
    }

    /**
     * 处理连接成功
     */
    public void onConnected() {
        connected = true;
        LOG.info("Connected to gateway");

        // 如果有保存的鉴权信息，自动重新鉴权
        if (robotId != null && robotSecret != null && !authenticated) {
            LOG.info("Auto re-authenticating with robotId: {}", robotId);

            // 在新线程中执行鉴权，避免阻塞WebSocket连接线程
            new Thread(() -> {
                try {
                    CompletableFuture<Boolean> authFuture = new CompletableFuture<>();
                    client.sendConnect(robotId, robotSecret, authFuture);

                    Boolean result = authFuture.get(30, TimeUnit.SECONDS);
                    if (result) {
                        LOG.info("Auto re-authentication successful");
                    } else {
                        LOG.warn("Auto re-authentication failed");
                        // 鉴权失败，清空鉴权信息，避免无限重试
                        robotId = null;
                        robotSecret = null;
                    }
                } catch (Exception e) {
                    LOG.error("Auto re-authentication error: {}", e.getMessage(), e);
                    // 鉴权异常，清空鉴权信息
                    robotId = null;
                    robotSecret = null;
                }
            }, "ReAuthThread").start();
        }
    }

    /**
     * 处理鉴权成功
     */
    public void onAuthenticated() {
        authenticated = true;
        LOG.info("Authenticated successfully as robot: {}", robotId);
        if (messageHandler != null) {
            messageHandler.onConnectionChanged(true);
        }
    }

    /**
     * 处理鉴权失败
     * 用于重连时的鉴权失败处理
     */
    public void onAuthenticationFailed() {
        // 这个方法主要用于重连时的鉴权失败
        // 清空鉴权信息，避免后续重连
        LOG.warn("Re-authentication failed, clearing credentials to prevent further reconnect");

        // 清空鉴权信息
        robotId = null;
        robotSecret = null;
        authenticated = false;

        // 停止运行，不再重连
        running = false;

        // 停止心跳
        stopHeartbeat();

        if (messageHandler != null) {
            messageHandler.onConnectionChanged(false);
        }
    }

    /**
     * 处理连接断开
     */
    public void onDisconnected() {
        boolean wasAuthenticated = authenticated;
        connected = false;
        authenticated = false;
        LOG.warn("Disconnected from gateway");

        if (wasAuthenticated && messageHandler != null) {
            messageHandler.onConnectionChanged(false);
        }

        // 只有当有鉴权信息且正在运行时才重连
        if (running && robotId != null && robotSecret != null) {
            scheduleReconnect();
        } else if (running && robotId == null) {
            // 没有鉴权信息，停止重连
            LOG.info("No auth info, stopping reconnect");
            running = false;
        }
    }

    /**
     * 获取WebSocket客户端
     * @return WebSocket客户端实例
     */
    public RobotGatewayClient getClient() {
        return client;
    }

    /**
     * 是否已连接
     * @return 如果已连接返回true，否则返回false
     */
    public boolean isConnected() {
        return connected && client.isOpen();
    }

    /**
     * 是否已鉴权
     * @return 如果已鉴权返回true，否则返回false
     */
    public boolean isAuthenticated() {
        return authenticated;
    }

    /**
     * 是否正在运行
     * @return 如果正在运行返回true，否则返回false
     */
    public boolean isRunning() {
        return running;
    }

    /**
     * 获取当前连接的机器人ID
     * @return 机器人ID
     */
    public String getRobotId() {
        return robotId;
    }

    /**
     * 启动心跳
     */
    private void startHeartbeat() {
        if (heartbeatExecutor != null && !heartbeatExecutor.isShutdown()) {
            return;
        }

        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "HeartbeatThread");
            thread.setDaemon(true);
            return thread;
        });

        lastHeartbeatTime = System.currentTimeMillis();

        heartbeatExecutor.scheduleAtFixedRate(() -> {
            try {
                if (authenticated && client.isOpen()) {
                    sendHeartbeat();
                }
            } catch (Exception e) {
                LOG.error("Heartbeat error: {}", e.getMessage());
            }
        }, heartbeatInterval, heartbeatInterval, TimeUnit.MILLISECONDS);

        LOG.info("Heartbeat started with interval: {} ms ({} seconds)", heartbeatInterval, heartbeatInterval / 1000);
    }

    /**
     * 停止心跳
     */
    private void stopHeartbeat() {
        if (heartbeatExecutor != null && !heartbeatExecutor.isShutdown()) {
            heartbeatExecutor.shutdown();
            try {
                if (!heartbeatExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    heartbeatExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                heartbeatExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            heartbeatExecutor = null;
            LOG.info("Heartbeat stopped");
        }
    }

    /**
     * 发送心跳
     */
    private void sendHeartbeat() {
        try {
            // 使用ping方法发送心跳（WebSocket协议自带）
            // 或者发送一个轻量级的心跳消息
            if (client.isOpen()) {
                // 创建心跳消息
                Map<String, Object> heartbeat = new HashMap<>();
                heartbeat.put("type", "heartbeat");
                heartbeat.put("timestamp", System.currentTimeMillis());

                // 发送心跳（这里不需要响应，只是保活）
                CompletableFuture<ResponseMessage> future = client.sendRequest("heartbeat", null);
                lastHeartbeatTime = System.currentTimeMillis();

                // 心跳不期望响应，只是保活
                LOG.debug("Heartbeat sent at {}", lastHeartbeatTime);
            }
        } catch (Exception e) {
            LOG.error("Failed to send heartbeat: {}", e.getMessage());
            // 心跳失败，可能连接已断开，触发重连
            onDisconnected();
        }
    }

    /**
     * 获取最后一次心跳时间
     * @return 最后一次心跳时间戳（毫秒）
     */
    public long getLastHeartbeatTime() {
        return lastHeartbeatTime;
    }
}
