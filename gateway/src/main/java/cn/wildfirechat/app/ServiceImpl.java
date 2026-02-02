package cn.wildfirechat.app;

import cn.wildfirechat.app.config.BotFatherConfig;
import cn.wildfirechat.app.gateway.SessionManager;
import cn.wildfirechat.app.protocol.PushMessage;
import cn.wildfirechat.app.service.RobotCommandHandler;
import cn.wildfirechat.common.ErrorCode;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.sdk.RobotService;
import cn.wildfirechat.sdk.model.IMResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;

import javax.annotation.PostConstruct;
import java.util.Arrays;

/**
 * 服务实现类
 * 处理IM服务推送的消息，转发到对应的机器人客户端
 * 集成BotFather功能，支持自动创建机器人
 */
@org.springframework.stereotype.Service
public class ServiceImpl implements Service {
    private static final Logger LOG = LoggerFactory.getLogger(ServiceImpl.class);

    @Autowired
    private SessionManager sessionManager;

    @Autowired
    private BotFatherConfig botFatherConfig;

    @Autowired
    private RobotCommandHandler robotCommandHandler;

    @Value("${im.url}")
    private String imUrl;

    // BotFather专用的RobotService实例
    private RobotService botFatherRobotService;

    @PostConstruct
    private void init() {
        // 初始化 BotFather 的 RobotService 实例
        if (botFatherConfig.isEnabled()) {
            try {
                String botFatherId = botFatherConfig.getRobotId();
                String botFatherSecret = botFatherConfig.getRobot().getSecret();
                if (botFatherId != null && !botFatherId.isEmpty()) {
                    botFatherRobotService = new RobotService(imUrl, botFatherId, botFatherSecret);
                    LOG.info("BotFather RobotService initialized for robot: {}", botFatherId);
                }
            } catch (Exception e) {
                LOG.error("Failed to initialize BotFather RobotService", e);
            }
        }
    }

    @Override
    @Async("asyncExecutor")
    public void onReceiveMessage(OutputMessageData messageData) {
        LOG.info("Received message {} for conversation: {}",
                messageData.getMessageId(),
                messageData.getConv() != null ? messageData.getConv().getTarget() : "unknown");

        // 获取目标机器人ID
        String targetRobotId = getTargetRobotId(messageData);

        if (targetRobotId == null) {
            LOG.warn("Cannot determine target robot ID for message {}", messageData.getMessageId());
            return;
        }

        // ========== BotFather 消息路由判断 ==========
        if (botFatherConfig.isEnabled() && isBotFatherMessage(targetRobotId)) {
            // 消息是发给 BotFather 的，走自动生成机器人业务
            LOG.info("Routing to BotFather service for robot: {}", targetRobotId);
            handleBotFatherMessage(messageData);
            return;
        }
        // ==========================================

        // 原有的网关业务：转发给对应的机器人客户端
        if (sessionManager.sendMessageToRobot(targetRobotId, PushMessage.message(messageData))) {
            LOG.info("Message sent to robot {}", targetRobotId);
        } else {
            LOG.warn("Robot {} not connected, message not delivered", targetRobotId);
        }
    }

    /**
     * 判断消息是否发给 BotFather
     */
    private boolean isBotFatherMessage(String targetRobotId) {
        String botFatherId = botFatherConfig.getRobotId();
        return botFatherId != null && botFatherId.equals(targetRobotId);
    }

    /**
     * 处理 BotFather 消息
     * 只支持单聊，群聊消息会被忽略
     */
    private void handleBotFatherMessage(OutputMessageData messageData) {
        try {
            // 判断是否需要响应（仅私聊）
            boolean needResponse = shouldRespond(messageData);
            if (!needResponse) {
                LOG.debug("BotFather ignores group chat message, only supports private chat");
                return;
            }

            // 提取消息内容
            String content = extractContent(messageData);
            if (content == null || content.isEmpty()) {
                return;
            }

            // 构建会话对象（私聊）
            Conversation conversation = messageData.getConv();
            Conversation replyConversation = new Conversation();
            replyConversation.setType(0); // 私聊
            replyConversation.setLine(conversation.getLine());
            replyConversation.setTarget(messageData.getSender()); // 回复给发送者

            // 调用命令处理器
            String response = robotCommandHandler.handleCommand(messageData.getSender(), content);

            // 发送回复
            sendMessageToUser(replyConversation, 0, response);

        } catch (Exception e) {
            LOG.error("Error handling BotFather message", e);
        }
    }

    /**
     * 判断是否需要响应消息
     * BotFather 只支持单聊，群聊消息会被忽略
     */
    private boolean shouldRespond(OutputMessageData messageData) {
        if (messageData.getConv() == null || messageData.getPayload() == null) {
            return false;
        }

        int convType = messageData.getConv().getType();

        // 仅处理私聊消息（type=0），忽略群聊消息
        return convType == 0;
    }

    /**
     * 提取消息内容
     */
    private String extractContent(OutputMessageData messageData) {
        if (messageData.getPayload() == null) {
            return null;
        }

        String content = messageData.getPayload().getSearchableContent();
        if (content == null || content.isEmpty()) {
            return null;
        }

        // 移除机器人名称（如果有@）
        String robotName = botFatherConfig.getRobot().getName();
        if (robotName != null && !robotName.isEmpty()) {
            content = content.replace("@" + robotName, "").trim();
        }

        return content;
    }

    /**
     * 发送消息给用户
     * BotFather 只支持私聊
     */
    private void sendMessageToUser(Conversation conversation, long replyMessageId, String message) {
        if (botFatherRobotService == null) {
            LOG.error("BotFather RobotService is not initialized");
            return;
        }

        try {
            MessagePayload payload = new MessagePayload();
            payload.setType(1); // 文本消息
            payload.setSearchableContent(message);

            // 发送消息（只支持普通发送，不支持回复）
            IMResult<SendMessageResult> result = botFatherRobotService.sendMessage(
                    botFatherConfig.getRobotId(),
                    conversation,
                    payload
            );

            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                LOG.info("Send message to user success");
            } else {
                LOG.error("Send message to user failed, error: {}", result != null ? result.getCode() : "null");
            }
        } catch (Exception e) {
            LOG.error("Exception when sending message to user", e);
        }
    }

    /**
     * 从消息中获取目标机器人ID
     */
    private String getTargetRobotId(OutputMessageData messageData) {
        // 消息的conv.target就是机器人ID
        if (messageData.getConv() != null) {
            if(messageData.getConv().getType() == 0) {
                return messageData.getConv().getTarget();
            } else {
                return messageData.getToRobotId();
            }
        }
        return null;
    }
}
