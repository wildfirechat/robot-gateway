package cn.wildfirechat.app;

import cn.wildfirechat.app.gateway.SessionManager;
import cn.wildfirechat.app.protocol.PushMessage;
import cn.wildfirechat.pojos.OutputMessageData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Async;

/**
 * 服务实现类
 * 处理IM服务推送的消息，转发到对应的机器人客户端
 */
@org.springframework.stereotype.Service
public class ServiceImpl implements Service {
    private static final Logger LOG = LoggerFactory.getLogger(ServiceImpl.class);

    @Autowired
    private SessionManager sessionManager;

    @Override
    @Async("asyncExecutor")
    public void onReceiveMessage(OutputMessageData messageData) {
        LOG.info("Received message {} for conversation: {}",
                messageData.getMessageId(),
                messageData.getConv() != null ? messageData.getConv().getTarget() : "unknown");

        // 根据消息目标查找对应的机器人会话
        // 这里需要从消息中获取目标机器人ID
        // 消息结构中，target字段是机器人ID
        String targetRobotId = getTargetRobotId(messageData);

        if (targetRobotId != null) {
            // 发送到指定的机器人
            if (sessionManager.sendMessageToRobot(targetRobotId, PushMessage.message(messageData))) {
                LOG.info("Message sent to robot {}", targetRobotId);
            } else {
                LOG.warn("Robot {} not connected, message not delivered", targetRobotId);
            }
        } else {
            LOG.warn("Cannot determine target robot ID for message {}", messageData.getMessageId());
        }
    }

    /**
     * 从消息中获取目标机器人ID
     */
    private String getTargetRobotId(OutputMessageData messageData) {
        // 消息的conv.target就是机器人ID
        if (messageData.getConv() != null) {
            return messageData.getConv().getTarget();
        }
        return null;
    }
}
