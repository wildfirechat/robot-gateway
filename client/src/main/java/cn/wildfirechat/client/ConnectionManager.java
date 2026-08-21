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
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

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
    private final long maxReconnectInterval;
    private final int maxReconnectAttempts;

    private volatile boolean running = false;
    private volatile boolean connected = false;
    private volatile boolean authenticated = false;
    private volatile String robotId;
    private volatile String robotSecret;

    private ScheduledExecutorService heartbeatExecutor;
    private ScheduledExecutorService reconnectExecutor;
    private volatile ScheduledFuture<?> reconnectFuture;
    // 重连去重：同一时刻最多一个重连任务、一个重连定时器（reconnectFuture），
    // 避免 onDisconnected 被多次触发时开出多个并发重连
    // （并发连接互相抢鉴权，会触发 "Already authenticated" 并
    // 让重连被关闭，导致客户端永久假死）。
    private final AtomicBoolean reconnecting = new AtomicBoolean(false);
    private volatile long lastHeartbeatTime;
    private final AtomicInteger reconnectAttempts = new AtomicInteger(0);

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler) {
        this(gatewayUrl, messageHandler, 5000, 270000); // 默认5秒重连，270秒(4.5分钟)心跳
    }

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler, long reconnectInterval) {
        this(gatewayUrl, messageHandler, reconnectInterval, 270000); // 默认270秒心跳
    }

    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler, long reconnectInterval, long heartbeatInterval) {
        this(gatewayUrl, messageHandler, reconnectInterval, heartbeatInterval, 60000, 0); // 默认最大重连间隔60秒，无限重试
    }

    /**
     * 创建连接管理器
     * @param gatewayUrl 网关地址
     * @param messageHandler 消息处理器
     * @param reconnectInterval 初始重连间隔（毫秒）
     * @param heartbeatInterval 心跳间隔（毫秒）
     * @param maxReconnectInterval 最大重连间隔（毫秒）
     * @param maxReconnectAttempts 最大重试次数（0表示无限重试）
     */
    public ConnectionManager(String gatewayUrl, MessageHandler messageHandler, long reconnectInterval, 
                             long heartbeatInterval, long maxReconnectInterval, int maxReconnectAttempts) {
        this.gatewayUrl = gatewayUrl;
        this.messageHandler = messageHandler;
        this.reconnectInterval = reconnectInterval;
        this.heartbeatInterval = heartbeatInterval;
        this.maxReconnectInterval = maxReconnectInterval;
        this.maxReconnectAttempts = maxReconnectAttempts;
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

        // 发送鉴权请求时即保存鉴权信息（与JS版sendConnect一致）。
        // 真正的鉴权失败（密钥错误等）会走onAuthenticationFailed清空凭据并停止重连，
        // 因此提前保存不会导致错误凭据的无限重试；而瞬态失败（"Already authenticated"）
        // 需要凭据来完成自动重试。
        this.robotId = robotId;
        this.robotSecret = secret;
        client.sendConnect(robotId, secret, authFuture);

        try {
            boolean result = authFuture.get(timeoutSeconds, TimeUnit.SECONDS);
            if (result) {
                LOG.info("Authentication successful, credentials saved for reconnect");
            } else if (!running) {
                // 真正的鉴权失败（onAuthenticationFailed已清空凭据并置running=false）
                LOG.warn("Authentication failed, stop connecting");
                stop(); // 鉴权失败，停止连接
            } else {
                // 瞬态鉴权失败（"Already authenticated"，并发socket竞态），
                // 重连已由onAuthenticationTransientFailure安排，凭据保留
                LOG.warn("Authentication transiently failed, reconnect scheduled for retry");
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

        // 取消待执行的重连任务
        cancelReconnect();

        // 停止心跳
        stopHeartbeat();

        // 停止重连执行器
        stopReconnectExecutor();

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
            // 先彻底拆除旧 socket（重连竞态保护），避免旧 socket 迟到的
            // close/message/auth 事件干扰新连接，触发 "Already authenticated" 竞态
            teardownClient();
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

        // 防重入：重连进行中，忽略并发触发
        if (!reconnecting.compareAndSet(false, true)) {
            LOG.debug("Reconnect already in progress, skip");
            return;
        }

        try {
            // 检查是否超过最大重试次数
            if (maxReconnectAttempts > 0 && reconnectAttempts.get() >= maxReconnectAttempts) {
                LOG.error("Max reconnect attempts ({}) reached, giving up", maxReconnectAttempts);
                running = false;
                if (messageHandler != null) {
                    messageHandler.onConnectionChanged(false);
                }
                return;
            }

            int currentAttempt = reconnectAttempts.incrementAndGet();
            LOG.info("Reconnecting to gateway: {} (attempt {})", gatewayUrl, currentAttempt);

            try {
                // 先彻底拆除旧 socket（重连竞态保护），避免旧 socket 迟到的
                // close/message/auth 事件干扰新连接，触发 "Already authenticated" 竞态
                teardownClient();
                client.reconnect();
            } catch (Exception e) {
                LOG.error("Failed to reconnect: {}", e.getMessage());
                // 重连失败后的再次调度（scheduleReconnect内有定时器去重）
                scheduleReconnect();
            }
        } finally {
            reconnecting.set(false);
        }
    }

    /**
     * 拆除当前socket（如果还处于打开/半关闭状态）
     */
    private void teardownClient() {
        try {
            if (client.isOpen() || client.isClosing()) {
                client.close();
            }
        } catch (Exception e) {
            LOG.warn("Error tearing down stale socket: {}", e.getMessage());
        }
    }

    /**
     * 计算退避后的重连间隔（指数退避策略）
     */
    private long getBackoffInterval() {
        // 指数退避：interval * 2^attempts，但不超过最大值
        long backoff = reconnectInterval * (1L << Math.min(reconnectAttempts.get(), 10)); // 最多左移10位，避免溢出
        return Math.min(backoff, maxReconnectInterval);
    }

    /**
     * 安排重连
     */
    private void scheduleReconnect() {
        if (!running) {
            return;
        }

        // 取消之前可能存在的重连任务
        cancelReconnect();

        long backoffInterval = getBackoffInterval();
        LOG.info("Scheduling reconnect in {} ms (attempt {})", backoffInterval, reconnectAttempts.get());

        if (reconnectExecutor == null || reconnectExecutor.isShutdown()) {
            reconnectExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread thread = new Thread(r, "ReconnectThread");
                thread.setDaemon(true);
                return thread;
            });
        }

        reconnectFuture = reconnectExecutor.schedule(() -> {
            if (running && !connected) {
                reconnect();
            }
        }, backoffInterval, TimeUnit.MILLISECONDS);
    }

    /**
     * 取消待执行的重连任务
     */
    private void cancelReconnect() {
        if (reconnectFuture != null && !reconnectFuture.isDone()) {
            reconnectFuture.cancel(false);
            reconnectFuture = null;
        }
    }

    /**
     * 停止重连执行器（异步关闭，不阻塞）
     */
    private void stopReconnectExecutor() {
        if (reconnectExecutor != null && !reconnectExecutor.isShutdown()) {
            reconnectExecutor.shutdown();
            // 异步等待关闭，不阻塞当前线程
            new Thread(() -> {
                try {
                    if (!reconnectExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                        reconnectExecutor.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    reconnectExecutor.shutdownNow();
                    Thread.currentThread().interrupt();
                }
            }, "ReconnectExecutorShutdownThread").start();
            reconnectExecutor = null;
        }
    }

    /**
     * 处理连接成功
     */
    public void onConnected() {
        connected = true;
        LOG.info("Connected to gateway");

        // 重置重连计数器
        reconnectAttempts.set(0);

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
                        // 鉴权失败的处理已在RobotGatewayClient中区分：
                        // 真正的鉴权失败（密钥错误等）走onAuthenticationFailed（已清空凭据、停止重连），
                        // 瞬态失败（"Already authenticated"）走onAuthenticationTransientFailure（保留凭据、已安排重连），
                        // 这里不再清空鉴权信息，避免瞬态错误导致永久假死
                    }
                } catch (Exception e) {
                    LOG.error("Auto re-authentication error: {}", e.getMessage(), e);
                    // 鉴权异常（如超时）属于瞬态问题，保留凭据，拆除当前socket并安排重连重试
                    teardownClient();
                    scheduleReconnect();
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
     * 处理瞬态鉴权失败（"Already authenticated"）
     * 这是并发 socket 竞态的瞬态错误，不是真正的鉴权失败（密钥错误）：
     * 保留鉴权信息、不停止自动重连，拆除当前 socket 并安排一次（去重后的）重连，
     * 等服务端清理掉旧的连接后再重新鉴权。
     * @param msg 服务端返回的失败消息
     */
    public void onAuthenticationTransientFailure(String msg) {
        LOG.warn("Transient authentication failure ({}), keeping credentials and scheduling reconnect", msg);
        authenticated = false;

        // 拆除当前 socket，其onClose会触发onDisconnected安排重连；
        // 这里再兜底安排一次（scheduleReconnect内有定时器去重，只保留一个重连任务）
        teardownClient();
        scheduleReconnect();
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
     * 停止心跳（异步关闭，不阻塞）
     */
    private void stopHeartbeat() {
        if (heartbeatExecutor != null && !heartbeatExecutor.isShutdown()) {
            ScheduledExecutorService executor = heartbeatExecutor;
            heartbeatExecutor = null;
            executor.shutdown();
            // 异步等待关闭，不阻塞当前线程
            new Thread(() -> {
                try {
                    if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                        executor.shutdownNow();
                    }
                } catch (InterruptedException e) {
                    executor.shutdownNow();
                    Thread.currentThread().interrupt();
                }
                LOG.info("Heartbeat stopped");
            }, "HeartbeatShutdownThread").start();
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
                // 必须吞掉异步失败：请求会一直挂起直到下一个响应，断线时
                // ResponseHandler.clear() 会以异常完成该future，
                // 未观察的异常不应影响宿主进程
                future.exceptionally(e -> {
                    LOG.warn("Heartbeat request failed: {}", e.getMessage());
                    return null;
                });
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
