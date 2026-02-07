package cn.wildfirechat.openclaw.core;

import cn.wildfirechat.client.RobotServiceClient;
import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.openclaw.config.OpenclawConfig;
import cn.wildfirechat.openclaw.converter.MessageConverter;
import cn.wildfirechat.openclaw.filter.WhitelistFilter;
import cn.wildfirechat.openclaw.openclaw.OpenclawWebSocketClient;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawInMessage;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawOutMessage;
import cn.wildfirechat.openclaw.session.GroupFilter;
import cn.wildfirechat.openclaw.session.SessionContextManager;
import cn.wildfirechat.sdk.model.IMResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;

/**
 * Openclaw桥接器
 * 负责野火IM与Openclaw Gateway之间的双向消息转发
 */
@Component
public class OpenclawBridge implements OpenclawWebSocketClient.OpenclawMessageHandler, MessageHandler {
    private static final Logger LOG = LoggerFactory.getLogger(OpenclawBridge.class);

    @Value("${wildfire.gateway.url}")
    private String wfGatewayUrl;

    @Value("${wildfire.robot.id}")
    private String wfRobotId;;

    @Value("${wildfire.robot.secret}")
    private String wfRobotSecret;;

    @Autowired
    private OpenclawConfig openclawConfig;

    @Autowired
    private MessageConverter messageConverter;

    @Autowired
    private GroupFilter groupFilter;

    @Autowired
    private WhitelistFilter whitelistFilter;

    @Autowired
    private SessionContextManager sessionContextManager;

    private RobotServiceClient wildfireClient;
    private OpenclawWebSocketClient openclawClient;

    private volatile boolean running = false;
    private volatile boolean isReconnecting = false;

    @PostConstruct
    public void init() {
        LOG.info("Initializing Openclaw Bridge...");
        start();
    }

    @PreDestroy
    public void destroy() {
        LOG.info("Destroying Openclaw Bridge...");
        stop();
    }

    /**
     * 启动桥接器
     */
    public void start() {
        if (running) {
            LOG.warn("Bridge already running");
            return;
        }

        running = true;

        // 1. 创建并连接到野火网关
        LOG.info("Connecting to Wildfire Gateway: {}", wfGatewayUrl);
        wildfireClient = new RobotServiceClient(
                wfGatewayUrl,
                this  // this implements MessageHandler
        );

        boolean connected = wildfireClient.connect(
                wfRobotId,
                wfRobotSecret
        );

        if (!connected) {
            LOG.error("Failed to connect to Wildfire Gateway, exiting...");
            stop();
            System.exit(1);
        }

        LOG.info("Connected to Wildfire Gateway as robot: {}", wildfireClient.getRobotId());

        // 2. 连接到Openclaw Gateway
        LOG.info("Connecting to Openclaw Gateway: {}", openclawConfig.getUrl());
        openclawClient = new OpenclawWebSocketClient(openclawConfig, this, sessionContextManager);
        try {
            openclawClient.connect();

            // 等待连接和认证完成（最多等待10秒）
            int maxWait = 100; // 10秒 (100次 * 100ms)
            int waitCount = 0;
            while (!openclawClient.isAuthenticated() && waitCount < maxWait) {
                Thread.sleep(100);
                waitCount++;
            }

            if (!openclawClient.isAuthenticated()) {
                LOG.error("Failed to authenticate with Openclaw Gateway within timeout, exiting...");
                stop();
                System.exit(1);
            }

        } catch (Exception e) {
            LOG.error("Failed to connect to Openclaw Gateway, exiting...", e);
            stop();
            System.exit(1);
        }

        LOG.info("Openclaw Bridge started successfully");
    }

    /**
     * 停止桥接器
     */
    public void stop() {
        running = false;

        if (wildfireClient != null) {
            // RobotServiceClient 没有 close 方法，不需要显式关闭
            wildfireClient = null;
        }

        if (openclawClient != null) {
            openclawClient.closeConnection();
        }

        LOG.info("Openclaw Bridge stopped");
    }

    // ==================== Wildfire Message Handler ====================

    @Override
    public void onMessage(PushMessage message) {
        if (!running) {
            LOG.warn("Bridge is not running, ignoring message");
            return;
        }

        try {
            LOG.info("Received message from Wildfire: sender={}, type={}",
                    message.getData() != null ? message.getData().getSender() : "null",
                    message.getData() != null && message.getData().getConv() != null ? message.getData().getConv().getType() : "null");

            // 0. 白名单过滤
            String senderId = message.getData() != null ? message.getData().getSender() : null;
            String targetId = message.getData() != null && message.getData().getConv() != null ? message.getData().getConv().getTarget() : null;
            boolean isGroup = message.getData() != null && message.getData().getConv() != null &&
                            (message.getData().getConv().getType() == 1 || message.getData().getConv().getType() == 2);

            if (!whitelistFilter.shouldProcess(senderId, targetId, isGroup)) {
                LOG.info("Message ignored by whitelist filter: sender={}, target={}, isGroup={}", senderId, targetId, isGroup);
                return;
            }

            // 1. 转换为Openclaw格式
            OpenclawOutMessage openclawMessage = messageConverter.convertToOpenclaw(message);
            if (openclawMessage == null) {
                LOG.debug("Failed to convert message, skipping");
                return;
            }

            // 2. 群聊过滤
            if (!groupFilter.shouldRespond(openclawMessage, wildfireClient.getRobotId())) {
                LOG.debug("Group filter blocked the message");
                return;
            }

            // 3. 发送到Openclaw Gateway（保存sender信息用于回复）
            if (senderId == null || senderId.trim().isEmpty()) {
                LOG.warn("Sender ID is null or empty, skipping message");
                return;
            }
            openclawClient.sendMessage(openclawMessage, senderId);

        } catch (Exception e) {
            LOG.error("Error processing Wildfire message", e);
        }
    }

    @Override
    public void onConnectionChanged(boolean connected) {
        LOG.info("Wildfire connection changed: {}", connected);
        if (!connected) {
            // 野火连接断开，SDK会自动重连
            LOG.warn("Wildfire connection lost, SDK will auto-reconnect");
        } else {
            LOG.info("Wildfire connection re-established");
        }
    }

    // ==================== Openclaw Message Handler ====================

    @Override
    public void onConnected() {
        LOG.info("Connected to Openclaw Gateway");
    }

    @Override
    public void onDisconnected(int code, String reason) {
        LOG.warn("Disconnected from Openclaw Gateway: code={}, reason={}", code, reason);
        // 触发重连逻辑
        if (running) {
            LOG.info("Attempting to reconnect to Openclaw Gateway...");
            scheduleOpenclawReconnect();
        }
    }

    @Override
    public void onResponse(OpenclawInMessage response) {
        if (!running) {
            LOG.warn("Bridge is not running, ignoring response");
            return;
        }

        try {
            LOG.info("Received response from Openclaw: text={}",
                    response.getMessage() != null && response.getMessage().getText() != null ?
                    response.getMessage().getText().substring(0, Math.min(50, response.getMessage().getText().length())) : "null" + "...");

            // 1. 转换为野火格式
            MessageConverter.WildfireSendMessage wfMessage =
                    messageConverter.convertFromOpenclaw(response);

            if (wfMessage == null) {
                LOG.error("Failed to convert Openclaw response to Wildfire format");
                return;
            }

            // 2. 通过野火SDK发送消息
            IMResult<cn.wildfirechat.pojos.SendMessageResult> result =
                    wildfireClient.sendMessage(
                            wfMessage.getConversation(),
                            wfMessage.getPayload()
                    );

            if (result.getCode() == 0) {
                LOG.info("Successfully sent message to Wildfire: target={}",
                        wfMessage.getTargetUserId());
            } else {
                LOG.error("Failed to send message to Wildfire: code={}, msg={}",
                        result.getCode(), result.getMsg());
            }

        } catch (Exception e) {
            LOG.error("Error processing Openclaw response", e);
        }
    }

    @Override
    public void onTyping(OpenclawInMessage typing) {
        LOG.debug("Openclaw is typing...");
        // 可以转发"正在输入"状态到野火（如果支持）
    }

    @Override
    public void onError(String error) {
        LOG.error("Error: {}", error);
    }

    // ==================== Public Methods ====================

    /**
     * 获取运行状态
     */
    public boolean isRunning() {
        return running;
    }

    /**
     * 获取野火连接状态
     */
    public boolean isWildfireConnected() {
        return wildfireClient != null && wildfireClient.isConnected();
    }

    /**
     * 获取Openclaw连接状态
     */
    public boolean isOpenclawConnected() {
        return openclawClient != null && openclawClient.isAuthenticated();
    }

    // ==================== Private Methods ====================

    /**
     * 调度Openclaw重连
     */
    private void scheduleOpenclawReconnect() {
        if (isReconnecting) {
            LOG.debug("Already reconnecting to Openclaw, skipping");
            return;
        }

        isReconnecting = true;

        new Thread(() -> {
            try {
                int retryCount = 0;
                int maxRetries = 10; // 最多重连10次
                long retryInterval = openclawConfig.getReconnectInterval();

                while (running && retryCount < maxRetries && !isOpenclawConnected()) {
                    retryCount++;
                    LOG.info("Reconnecting to Openclaw Gateway (attempt {}/{}): {}",
                            retryCount, maxRetries, openclawConfig.getUrl());

                    try {
                        // 创建新的连接
                        openclawClient = new OpenclawWebSocketClient(openclawConfig, this, sessionContextManager);
                        openclawClient.connect();

                        // 等待连接和认证完成（最多等待5秒）
                        int maxWait = 50;
                        int waitCount = 0;
                        while (!openclawClient.isAuthenticated() && waitCount < maxWait) {
                            Thread.sleep(100);
                            waitCount++;
                        }

                        if (openclawClient.isAuthenticated()) {
                            LOG.info("Successfully reconnected to Openclaw Gateway");
                            break;
                        } else {
                            LOG.warn("Openclaw Gateway reconnection attempt {} failed", retryCount);
                        }

                    } catch (Exception e) {
                        LOG.error("Error reconnecting to Openclaw Gateway (attempt {})", retryCount, e);
                    }

                    // 等待一段时间后重试
                    if (retryCount < maxRetries && !isOpenclawConnected()) {
                        Thread.sleep(retryInterval);
                    }
                }

                if (!isOpenclawConnected()) {
                    LOG.error("Failed to reconnect to Openclaw Gateway after {} attempts", maxRetries);
                }

            } catch (Exception e) {
                LOG.error("Error in Openclaw reconnection scheduler", e);
            } finally {
                isReconnecting = false;
            }
        }, "OpenclawReconnectThread").start();
    }
}
