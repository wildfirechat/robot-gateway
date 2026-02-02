package cn.wildfirechat.moltbot.core;

import cn.wildfirechat.client.RobotServiceClient;
import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.moltbot.config.MoltbotConfig;
import cn.wildfirechat.moltbot.converter.MessageConverter;
import cn.wildfirechat.moltbot.filter.WhitelistFilter;
import cn.wildfirechat.moltbot.moltbot.MoltbotWebSocketClient;
import cn.wildfirechat.moltbot.moltbot.protocol.MoltbotInMessage;
import cn.wildfirechat.moltbot.moltbot.protocol.MoltbotOutMessage;
import cn.wildfirechat.moltbot.session.GroupFilter;
import cn.wildfirechat.sdk.model.IMResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;

/**
 * Moltbot桥接器
 * 负责野火IM与Moltbot Gateway之间的双向消息转发
 */
@Component
public class MoltbotBridge implements MoltbotWebSocketClient.MoltbotMessageHandler, MessageHandler {
    private static final Logger LOG = LoggerFactory.getLogger(MoltbotBridge.class);

    @Value("${wildfire.gateway.url}")
    private String wfGatewayUrl;

    @Value("${wildfire.robot.id}")
    private String wfRobotId;;

    @Value("${wildfire.robot.secret}")
    private String wfRobotSecret;;

    @Autowired
    private MoltbotConfig moltbotConfig;

    @Autowired
    private MessageConverter messageConverter;

    @Autowired
    private GroupFilter groupFilter;

    @Autowired
    private WhitelistFilter whitelistFilter;

    private RobotServiceClient wildfireClient;
    private MoltbotWebSocketClient moltbotClient;

    private volatile boolean running = false;
    private volatile boolean isReconnecting = false;

    @PostConstruct
    public void init() {
        LOG.info("Initializing Moltbot Bridge...");
        start();
    }

    @PreDestroy
    public void destroy() {
        LOG.info("Destroying Moltbot Bridge...");
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

        // 2. 连接到Moltbot Gateway
        LOG.info("Connecting to Moltbot Gateway: {}", moltbotConfig.getUrl());
        moltbotClient = new MoltbotWebSocketClient(moltbotConfig, this);
        try {
            moltbotClient.connect();

            // 等待连接和认证完成（最多等待10秒）
            int maxWait = 100; // 10秒 (100次 * 100ms)
            int waitCount = 0;
            while (!moltbotClient.isAuthenticated() && waitCount < maxWait) {
                Thread.sleep(100);
                waitCount++;
            }

            if (!moltbotClient.isAuthenticated()) {
                LOG.error("Failed to authenticate with Moltbot Gateway within timeout, exiting...");
                stop();
                System.exit(1);
            }

        } catch (Exception e) {
            LOG.error("Failed to connect to Moltbot Gateway, exiting...", e);
            stop();
            System.exit(1);
        }

        LOG.info("Moltbot Bridge started successfully");
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

        if (moltbotClient != null) {
            moltbotClient.closeConnection();
        }

        LOG.info("Moltbot Bridge stopped");
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

            // 1. 转换为Moltbot格式
            MoltbotOutMessage moltbotMessage = messageConverter.convertToMoltbot(message);
            if (moltbotMessage == null) {
                LOG.debug("Failed to convert message or non-text message, skipping");
                return;
            }

            // 2. 群聊过滤
            if (!groupFilter.shouldRespond(moltbotMessage, wildfireClient.getRobotId())) {
                LOG.debug("Group filter blocked the message");
                return;
            }

            // 3. 发送到Moltbot Gateway（保存sender信息用于回复）
            moltbotClient.sendMessage(moltbotMessage, senderId);

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

    // ==================== Moltbot Message Handler ====================

    @Override
    public void onConnected() {
        LOG.info("Connected to Moltbot Gateway");
    }

    @Override
    public void onDisconnected(int code, String reason) {
        LOG.warn("Disconnected from Moltbot Gateway: code={}, reason={}", code, reason);
        // 触发重连逻辑
        if (running) {
            LOG.info("Attempting to reconnect to Moltbot Gateway...");
            scheduleMoltbotReconnect();
        }
    }

    @Override
    public void onResponse(MoltbotInMessage response) {
        if (!running) {
            LOG.warn("Bridge is not running, ignoring response");
            return;
        }

        try {
            LOG.info("Received response from Moltbot: text={}",
                    response.getMessage() != null && response.getMessage().getText() != null ?
                    response.getMessage().getText().substring(0, Math.min(50, response.getMessage().getText().length())) : "null" + "...");

            // 1. 转换为野火格式
            MessageConverter.WildfireSendMessage wfMessage =
                    messageConverter.convertFromMoltbot(response);

            if (wfMessage == null) {
                LOG.error("Failed to convert Moltbot response to Wildfire format");
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
            LOG.error("Error processing Moltbot response", e);
        }
    }

    @Override
    public void onTyping(MoltbotInMessage typing) {
        LOG.debug("Moltbot is typing...");
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
     * 获取Moltbot连接状态
     */
    public boolean isMoltbotConnected() {
        return moltbotClient != null && moltbotClient.isAuthenticated();
    }

    // ==================== Private Methods ====================

    /**
     * 调度Moltbot重连
     */
    private void scheduleMoltbotReconnect() {
        if (isReconnecting) {
            LOG.debug("Already reconnecting to Moltbot, skipping");
            return;
        }

        isReconnecting = true;

        new Thread(() -> {
            try {
                int retryCount = 0;
                int maxRetries = 10; // 最多重连10次
                long retryInterval = moltbotConfig.getReconnectInterval();

                while (running && retryCount < maxRetries && !isMoltbotConnected()) {
                    retryCount++;
                    LOG.info("Reconnecting to Moltbot Gateway (attempt {}/{}): {}",
                            retryCount, maxRetries, moltbotConfig.getUrl());

                    try {
                        // 创建新的连接
                        moltbotClient = new MoltbotWebSocketClient(moltbotConfig, this);
                        moltbotClient.connect();

                        // 等待连接和认证完成（最多等待5秒）
                        int maxWait = 50;
                        int waitCount = 0;
                        while (!moltbotClient.isAuthenticated() && waitCount < maxWait) {
                            Thread.sleep(100);
                            waitCount++;
                        }

                        if (moltbotClient.isAuthenticated()) {
                            LOG.info("Successfully reconnected to Moltbot Gateway");
                            break;
                        } else {
                            LOG.warn("Moltbot Gateway reconnection attempt {} failed", retryCount);
                        }

                    } catch (Exception e) {
                        LOG.error("Error reconnecting to Moltbot Gateway (attempt {})", retryCount, e);
                    }

                    // 等待一段时间后重试
                    if (retryCount < maxRetries && !isMoltbotConnected()) {
                        Thread.sleep(retryInterval);
                    }
                }

                if (!isMoltbotConnected()) {
                    LOG.error("Failed to reconnect to Moltbot Gateway after {} attempts", maxRetries);
                }

            } catch (Exception e) {
                LOG.error("Error in Moltbot reconnection scheduler", e);
            } finally {
                isReconnecting = false;
            }
        }, "MoltbotReconnectThread").start();
    }
}
