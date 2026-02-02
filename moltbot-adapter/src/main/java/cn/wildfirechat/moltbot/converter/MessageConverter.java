package cn.wildfirechat.moltbot.converter;

import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.moltbot.moltbot.protocol.MoltbotInMessage;
import cn.wildfirechat.moltbot.moltbot.protocol.MoltbotOutMessage;
import cn.wildfirechat.pojos.Conversation;
import cn.wildfirechat.pojos.MessagePayload;
import cn.wildfirechat.sdk.messagecontent.MessageContent;
import cn.wildfirechat.sdk.messagecontent.StreamTextGeneratedMessageContent;
import cn.wildfirechat.sdk.messagecontent.StreamTextGeneratingMessageContent;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 消息格式转换器
 * 负责野火IM格式与Moltbot格式的双向转换
 */
@Component
public class MessageConverter {
    private static final Logger LOG = LoggerFactory.getLogger(MessageConverter.class);

    private final Gson gson = new Gson();

    /**
     * 野火IM PushMessage → Moltbot OutMessage
     */
    public MoltbotOutMessage convertToMoltbot(PushMessage wildfireMessage) {
        if (wildfireMessage == null || wildfireMessage.getData() == null) {
            LOG.warn("Empty message data");
            return null;
        }

        try {
            // 提取消息内容
            String text = extractTextContent(wildfireMessage.getData());
            if (text == null || text.trim().isEmpty()) {
                LOG.debug("Non-text message, skipping: type={}",
                        wildfireMessage.getData().getPayload() != null ?
                        wildfireMessage.getData().getPayload().getType() : "null");
                return null;
            }

            // 判断会话类型
            Conversation conv = wildfireMessage.getData().getConv();
            boolean isGroup = (conv != null && (conv.getType() == 1 || conv.getType() == 2)); // 1=群聊, 2=超群

            // 构建Moltbot消息
            MoltbotOutMessage moltbotMessage = new MoltbotOutMessage();

            // 设置通道信息
            MoltbotOutMessage.Channel channel = new MoltbotOutMessage.Channel();
            channel.setId("wildfire-im");
            channel.setThreadId(conv != null ? (conv.getType() == 0?wildfireMessage.getData().getSender():conv.getTarget()):"");
            channel.setPeerId(wildfireMessage.getData().getSender());
            channel.setPeerName(wildfireMessage.getData().getSender());
            channel.setGroup(isGroup);
            moltbotMessage.setChannel(channel);

            // 提取@提及信息
            List<MoltbotOutMessage.Message.Mention> mentions = extractMentions(wildfireMessage.getData());

            // 设置消息内容
            MoltbotOutMessage.Message message = new MoltbotOutMessage.Message();
            message.setId(UUID.randomUUID().toString());
            message.setText(text);
            message.setTimestamp(System.currentTimeMillis());
            message.setMentions(mentions);
            moltbotMessage.setMessage(message);

            // 会话ID（基于threadId+peerId）
            String sessionId = generateSessionId(
                    conv != null ? conv.getTarget() : "",
                    wildfireMessage.getData().getSender()
            );

            MoltbotOutMessage.Session session = new MoltbotOutMessage.Session();
            session.setId(sessionId);
            moltbotMessage.setSession(session);

            LOG.debug("Converted Wildfire message to Moltbot: threadId={}, peerId={}, isGroup={}",
                    channel.getThreadId(), channel.getPeerId(), channel.isGroup());

            return moltbotMessage;

        } catch (Exception e) {
            LOG.error("Failed to convert Wildfire message to Moltbot", e);
            return null;
        }
    }

    /**
     * Moltbot InMessage → 野火IM发送参数
     */
    public WildfireSendMessage convertFromMoltbot(MoltbotInMessage moltbotMessage) {
        if (moltbotMessage == null || moltbotMessage.getChannel() == null) {
            LOG.warn("Invalid Moltbot message");
            return null;
        }

        try {
            MoltbotInMessage.Channel channel = moltbotMessage.getChannel();
            MoltbotInMessage.Message message = moltbotMessage.getMessage();

            // 构建会话对象
            Conversation conversation = new Conversation();
            // 如果有threadId且不是peerId，说明是群聊
            boolean isGroup = channel.getThreadId() != null &&
                            !channel.getThreadId().equals(channel.getPeerId());

            conversation.setType(isGroup ? 1 : 0);  // 0=单聊, 1=群聊
            conversation.setTarget(channel.getThreadId() != null ?
                                    channel.getThreadId() :
                                    channel.getPeerId());
            conversation.setLine(0);

            // 构建消息内容
            MessagePayload payload = new MessagePayload();
            payload.setType(1);  // 文本消息
            payload.setSearchableContent(message != null ? message.getText() : "");

            WildfireSendMessage wfMessage = new WildfireSendMessage();
            wfMessage.setConversation(conversation);
            wfMessage.setPayload(payload);
            wfMessage.setTargetUserId(channel.getPeerId());
            wfMessage.setGroup(isGroup);
            wfMessage.setText(message != null ? message.getText() : "");

            // 提取流式消息元数据
            if (message != null && message.getExtra() != null) {
                String streamId = (String) message.getExtra("streamId");
                String state = (String) message.getExtra("state");
                if("generating".equals(state)) {
                    MessageContent messageContent = new StreamTextGeneratingMessageContent(message != null ? message.getText() : "", streamId);
                    wfMessage.setPayload(messageContent.encode());
                } else if("completed".equals(state)) {
                    MessageContent messageContent = new StreamTextGeneratedMessageContent(message != null ? message.getText() : "", streamId);
                    wfMessage.setPayload(messageContent.encode());
                }
                wfMessage.setStreamId(streamId);
                wfMessage.setStreamState(state);
            }

            LOG.debug("Converted Moltbot message to Wildfire: target={}, isGroup={}, streamId={}, state={}, text={}",
                    wfMessage.getTargetUserId(), wfMessage.isGroup(),
                    wfMessage.getStreamId(), wfMessage.getStreamState(),
                    wfMessage.getText() != null ? wfMessage.getText().substring(0, Math.min(50, wfMessage.getText().length())) : "null" + "...");

            return wfMessage;

        } catch (Exception e) {
            LOG.error("Failed to convert Moltbot message to Wildfire", e);
            return null;
        }
    }

    /**
     * 提取文本内容
     */
    private String extractTextContent(cn.wildfirechat.pojos.OutputMessageData data) {
        if (data.getPayload() == null) {
            return null;
        }

        int type = data.getPayload().getType();
        if (type == 1) {
            // 文本消息
            return data.getPayload().getSearchableContent();
        } else if (type == 0) {
            // 未知类型
            return null;
        } else {
            // 其他类型（图片、语音、视频、文件等）
            // 可以转换为描述性文本
            return String.format("[消息类型:%d]", type);
        }
    }

    /**
     * 提取@提及信息
     */
    private List<MoltbotOutMessage.Message.Mention> extractMentions(cn.wildfirechat.pojos.OutputMessageData data) {
        List<MoltbotOutMessage.Message.Mention> mentions = new ArrayList<>();

        // 暂时不实现提及检测，因为OutputMessageData中没有mentionedUsers字段
        // 如果后续SDK支持，可以在这里添加

        return mentions;
    }

    /**
     * 生成会话ID
     */
    private String generateSessionId(String threadId, String peerId) {
        return threadId + ":" + peerId;
    }

    /**
     * 野火发送消息的封装类
     */
    public static class WildfireSendMessage {
        private Conversation conversation;
        private MessagePayload payload;
        private String targetUserId;
        private boolean isGroup;
        private String text;
        private String streamId;   // 流式消息ID
        private String streamState; // 流式消息状态：generating或completed

        public Conversation getConversation() {
            return conversation;
        }

        public void setConversation(Conversation conversation) {
            this.conversation = conversation;
        }

        public MessagePayload getPayload() {
            return payload;
        }

        public void setPayload(MessagePayload payload) {
            this.payload = payload;
        }

        public String getTargetUserId() {
            return targetUserId;
        }

        public void setTargetUserId(String targetUserId) {
            this.targetUserId = targetUserId;
        }

        public boolean isGroup() {
            return isGroup;
        }

        public void setGroup(boolean group) {
            isGroup = group;
        }

        public String getText() {
            return text;
        }

        public void setText(String text) {
            this.text = text;
        }

        public String getStreamId() {
            return streamId;
        }

        public void setStreamId(String streamId) {
            this.streamId = streamId;
        }

        public String getStreamState() {
            return streamState;
        }

        public void setStreamState(String streamState) {
            this.streamState = streamState;
        }
    }
}
