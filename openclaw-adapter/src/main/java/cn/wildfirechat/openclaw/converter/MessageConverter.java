package cn.wildfirechat.openclaw.converter;

import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawInMessage;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawOutMessage;
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
 * 负责野火IM格式与Openclaw格式的双向转换
 */
@Component
public class MessageConverter {
    private static final Logger LOG = LoggerFactory.getLogger(MessageConverter.class);

    private final Gson gson = new Gson();

    /**
     * 野火IM PushMessage → Openclaw OutMessage
     */
    public OpenclawOutMessage convertToOpenclaw(PushMessage wildfireMessage) {
        if (wildfireMessage == null || wildfireMessage.getData() == null) {
            LOG.warn("Empty message data");
            return null;
        }

        try {
            // 提取消息内容（支持文本、语音、图片、视频等）
            String text = extractTextContent(wildfireMessage.getData());
            if (text == null) {
                LOG.debug("Unknown or unsupported message type: type={}",
                        wildfireMessage.getData().getPayload() != null ?
                        wildfireMessage.getData().getPayload().getType() : "null");
                return null;
            }

            // 判断会话类型
            Conversation conv = wildfireMessage.getData().getConv();
            boolean isGroup = (conv != null && (conv.getType() == 1 || conv.getType() == 2)); // 1=群聊, 2=超群

            // 构建Openclaw消息
            OpenclawOutMessage openclawMessage = new OpenclawOutMessage();

            // 设置通道信息
            OpenclawOutMessage.Channel channel = new OpenclawOutMessage.Channel();
            channel.setId("wildfire-im");
            channel.setThreadId(conv != null ? (conv.getType() == 0?wildfireMessage.getData().getSender():conv.getTarget()):"");
            channel.setPeerId(wildfireMessage.getData().getSender());
            channel.setPeerName(wildfireMessage.getData().getSender());
            channel.setGroup(isGroup);
            openclawMessage.setChannel(channel);

            // 提取@提及信息
            List<OpenclawOutMessage.Message.Mention> mentions = extractMentions(wildfireMessage.getData());

            // 检测消息类型和媒体URL
            MediaInfo mediaInfo = detectMediaInfo(wildfireMessage.getData());

            // 设置消息内容
            OpenclawOutMessage.Message message = new OpenclawOutMessage.Message();
            message.setId(UUID.randomUUID().toString());
            message.setText(text);
            message.setTimestamp(System.currentTimeMillis());
            message.setMentions(mentions);
            
            // 设置媒体信息（如果有）
            if (mediaInfo != null && mediaInfo.getUrl() != null) {
                message.setMediaUrl(mediaInfo.getUrl());
                message.setMediaType(mediaInfo.getType());
            }
            
            openclawMessage.setMessage(message);

            // 会话ID（基于threadId+peerId）
            String sessionId = generateSessionId(
                    conv != null ? conv.getTarget() : "",
                    wildfireMessage.getData().getSender()
            );

            OpenclawOutMessage.Session session = new OpenclawOutMessage.Session();
            session.setId(sessionId);
            openclawMessage.setSession(session);

            LOG.debug("Converted Wildfire message to Openclaw: threadId={}, peerId={}, isGroup={}",
                    channel.getThreadId(), channel.getPeerId(), channel.isGroup());

            return openclawMessage;

        } catch (Exception e) {
            LOG.error("Failed to convert Wildfire message to Openclaw", e);
            return null;
        }
    }

    /**
     * Openclaw InMessage → 野火IM发送参数
     */
    public WildfireSendMessage convertFromOpenclaw(OpenclawInMessage openclawMessage) {
        if (openclawMessage == null || openclawMessage.getChannel() == null) {
            LOG.warn("Invalid Openclaw message");
            return null;
        }

        try {
            OpenclawInMessage.Channel channel = openclawMessage.getChannel();
            OpenclawInMessage.Message message = openclawMessage.getMessage();

            // 构建会话对象
            Conversation conversation = new Conversation();
            // 如果有threadId且不是peerId，说明是群聊
            boolean isGroup = channel.getThreadId() != null &&
                            channel.getPeerId() != null &&
                            !channel.getThreadId().equals(channel.getPeerId());

            conversation.setType(isGroup ? 1 : 0);  // 0=单聊, 1=群聊
            conversation.setTarget(channel.getThreadId() != null ?
                                    channel.getThreadId() :
                                    (channel.getPeerId() != null ? channel.getPeerId() : ""));
            conversation.setLine(0);

            // 构建消息内容
            MessagePayload payload = new MessagePayload();
            payload.setType(1);  // 文本消息
            payload.setSearchableContent(message != null ? message.getText() : "");

            WildfireSendMessage wfMessage = new WildfireSendMessage();
            wfMessage.setConversation(conversation);
            wfMessage.setPayload(payload);
            wfMessage.setTargetUserId(channel.getPeerId() != null ? channel.getPeerId() : "");
            wfMessage.setGroup(isGroup);
            wfMessage.setText(message != null ? message.getText() : "");

            // 提取流式消息元数据
            if (message != null && message.getExtra() != null) {
                String streamId = (String) message.getExtra("streamId");
                String state = (String) message.getExtra("state");
                if("generating".equals(state) || "start".equals(state)) {
                    MessageContent messageContent = new StreamTextGeneratingMessageContent(message != null ? message.getText() : "", streamId);
                    wfMessage.setPayload(messageContent.encode());
                } else if("completed".equals(state)) {
                    MessageContent messageContent = new StreamTextGeneratedMessageContent(message != null ? message.getText() : "", streamId);
                    wfMessage.setPayload(messageContent.encode());
                }
                wfMessage.setStreamId(streamId);
                wfMessage.setStreamState(state);
            }

            LOG.debug("Converted Openclaw message to Wildfire: target={}, isGroup={}, streamId={}, state={}, text={}",
                    wfMessage.getTargetUserId(), wfMessage.isGroup(),
                    wfMessage.getStreamId(), wfMessage.getStreamState(),
                    wfMessage.getText() != null ? wfMessage.getText().substring(0, Math.min(50, wfMessage.getText().length())) : "null" + "...");

            return wfMessage;

        } catch (Exception e) {
            LOG.error("Failed to convert Openclaw message to Wildfire", e);
            return null;
        }
    }

    /**
     * 提取消息内容
     * 支持文本、语音、图片、视频等多种类型
     */
    private String extractTextContent(cn.wildfirechat.pojos.OutputMessageData data) {
        if (data.getPayload() == null) {
            return null;
        }

        int type = data.getPayload().getType();
        MessagePayload payload = data.getPayload();
        com.google.gson.JsonObject extraJson = parseExtraJson(payload.getExtra());

        switch (type) {
            case 1:
                // 文本消息
                return payload.getSearchableContent();

            case 2:
                // 语音消息
                String voiceUrl = extractMediaUrl(payload);
                int duration = getIntFromExtra(extraJson, "duration", 0);
                return String.format("[语音消息] 时长:%d秒 URL:%s", duration, voiceUrl != null ? voiceUrl : "未知");

            case 3:
                // 图片消息
                String imageUrl = extractMediaUrl(payload);
                String imageDesc = payload.getSearchableContent();
                if (imageDesc == null || imageDesc.isEmpty()) {
                    imageDesc = "图片";
                }
                return String.format("[图片消息] %s URL:%s", imageDesc, imageUrl != null ? imageUrl : "未知");

            case 4:
                // 视频消息
                String videoUrl = extractMediaUrl(payload);
                String videoThumbnail = hasExtraField(extraJson, "thumbnail") ? "有缩略图" : "无缩略图";
                int videoDuration = getIntFromExtra(extraJson, "duration", 0);
                return String.format("[视频消息] 时长:%d秒 %s URL:%s",
                    videoDuration,
                    videoThumbnail,
                    videoUrl != null ? videoUrl : "未知");

            case 5:
                // 文件消息
                String fileUrl = extractMediaUrl(payload);
                String fileName = payload.getSearchableContent();
                long fileSize = getLongFromExtra(extraJson, "size", 0);
                return String.format("[文件消息] %s 大小:%s URL:%s",
                    fileName != null ? fileName : "未知文件",
                    formatFileSize(fileSize),
                    fileUrl != null ? fileUrl : "未知");

            case 0:
                // 未知类型
                return null;

            default:
                // 其他类型
                LOG.debug("Unknown message type: {}", type);
                return String.format("[消息类型:%d] %s", type, payload.getSearchableContent() != null ? payload.getSearchableContent() : "");
        }
    }

    /**
     * 解析 extra 字段为 JSON 对象
     */
    private com.google.gson.JsonObject parseExtraJson(String extra) {
        if (extra == null || extra.isEmpty()) {
            return null;
        }
        try {
            return gson.fromJson(extra, com.google.gson.JsonObject.class);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 从 extra JSON 中获取 int 值
     */
    private int getIntFromExtra(com.google.gson.JsonObject extraJson, String field, int defaultValue) {
        if (extraJson != null && extraJson.has(field)) {
            try {
                return extraJson.get(field).getAsInt();
            } catch (Exception e) {
                return defaultValue;
            }
        }
        return defaultValue;
    }

    /**
     * 从 extra JSON 中获取 long 值
     */
    private long getLongFromExtra(com.google.gson.JsonObject extraJson, String field, long defaultValue) {
        if (extraJson != null && extraJson.has(field)) {
            try {
                return extraJson.get(field).getAsLong();
            } catch (Exception e) {
                return defaultValue;
            }
        }
        return defaultValue;
    }

    /**
     * 检查 extra JSON 中是否存在字段
     */
    private boolean hasExtraField(com.google.gson.JsonObject extraJson, String field) {
        return extraJson != null && extraJson.has(field);
    }

    /**
     * 从 payload 中提取媒体 URL
     * 优先使用 remoteMediaUrl 字段（媒体类消息专用）
     */
    private String extractMediaUrl(MessagePayload payload) {
        // 首先尝试使用 remoteMediaUrl 字段（媒体类消息）
        if (payload.getRemoteMediaUrl() != null && !payload.getRemoteMediaUrl().isEmpty()) {
            return payload.getRemoteMediaUrl();
        }

        // 回退：尝试从 extra JSON 中获取 url 字段
        com.google.gson.JsonObject extraJson = parseExtraJson(payload.getExtra());
        if (extraJson != null && extraJson.has("url")) {
            try {
                return extraJson.get("url").getAsString();
            } catch (Exception e) {
                // 忽略解析错误
            }
        }

        // 回退：尝试从 extra 字符串中获取（如果 extra 是纯 URL）
        if (payload.getExtra() != null && !payload.getExtra().isEmpty()) {
            String extra = payload.getExtra();
            if (extra.startsWith("http://") || extra.startsWith("https://")) {
                return extra;
            }
        }

        return null;
    }

    /**
     * 格式化文件大小
     */
    private String formatFileSize(long size) {
        if (size <= 0) return "未知";
        if (size < 1024) return size + "B";
        if (size < 1024 * 1024) return String.format("%.2fKB", size / 1024.0);
        if (size < 1024 * 1024 * 1024) return String.format("%.2fMB", size / (1024.0 * 1024));
        return String.format("%.2fGB", size / (1024.0 * 1024 * 1024));
    }

    /**
     * 检测消息中的媒体信息
     */
    private MediaInfo detectMediaInfo(cn.wildfirechat.pojos.OutputMessageData data) {
        if (data.getPayload() == null) {
            return null;
        }

        int type = data.getPayload().getType();
        String mediaUrl = extractMediaUrl(data.getPayload());

        if (mediaUrl == null || mediaUrl.isEmpty()) {
            return null;
        }

        switch (type) {
            case 2: // 语音
                return new MediaInfo(mediaUrl, "audio");
            case 3: // 图片
                return new MediaInfo(mediaUrl, "image");
            case 4: // 视频
                return new MediaInfo(mediaUrl, "video");
            case 5: // 文件
                return new MediaInfo(mediaUrl, "file");
            default:
                return null;
        }
    }

    /**
     * 媒体信息内部类
     */
    private static class MediaInfo {
        private final String url;
        private final String type;

        public MediaInfo(String url, String type) {
            this.url = url;
            this.type = type;
        }

        public String getUrl() {
            return url;
        }

        public String getType() {
            return type;
        }
    }

    /**
     * 提取@提及信息
     */
    private List<OpenclawOutMessage.Message.Mention> extractMentions(cn.wildfirechat.pojos.OutputMessageData data) {
        List<OpenclawOutMessage.Message.Mention> mentions = new ArrayList<>();

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
