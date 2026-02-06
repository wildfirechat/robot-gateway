package cn.wildfirechat.openclaw.openclaw.protocol;

import java.util.List;

/**
 * 从Openclaw Gateway接收的消息
 */
public class OpenclawInMessage {
    /**
     * 消息类型：response, typing, error, event
     */
    private String type;

    /**
     * 事件类型（type=event时有值，如connect.challenge）
     */
    private String event;

    /**
     * 事件负载（type=event时有值）
     */
    private Payload payload;

    /**
     * 通道信息（type=response时有值）
     */
    private Channel channel;

    /**
     * 消息内容（type=response时有值）
     */
    private Message message;

    /**
     * 元数据（可选）
     */
    private Meta meta;

    /**
     * 错误信息（type=error时有值）
     */
    private String error;

    public OpenclawInMessage() {
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getEvent() {
        return event;
    }

    public void setEvent(String event) {
        this.event = event;
    }

    public Payload getPayload() {
        return payload;
    }

    public void setPayload(Payload payload) {
        this.payload = payload;
    }

    public Channel getChannel() {
        return channel;
    }

    public void setChannel(Channel channel) {
        this.channel = channel;
    }

    public Message getMessage() {
        return message;
    }

    public void setMessage(Message message) {
        this.message = message;
    }

    public Meta getMeta() {
        return meta;
    }

    public void setMeta(Meta meta) {
        this.meta = meta;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    /**
     * 通道信息
     */
    public static class Channel {
        private String threadId;
        private String peerId;

        public Channel() {
        }

        public Channel(String threadId, String peerId) {
            this.threadId = threadId;
            this.peerId = peerId;
        }

        public String getThreadId() {
            return threadId;
        }

        public void setThreadId(String threadId) {
            this.threadId = threadId;
        }

        public String getPeerId() {
            return peerId;
        }

        public void setPeerId(String peerId) {
            this.peerId = peerId;
        }
    }

    /**
     * 消息内容
     */
    public static class Message {
        private String text;
        private List<Block> blocks;
        private java.util.Map<String, Object> extra;  // 额外的元数据（如streamId, state等）

        public Message() {
        }

        public String getText() {
            return text;
        }

        public void setText(String text) {
            this.text = text;
        }

        public List<Block> getBlocks() {
            return blocks;
        }

        public void setBlocks(List<Block> blocks) {
            this.blocks = blocks;
        }

        public java.util.Map<String, Object> getExtra() {
            return extra;
        }

        public void setExtra(java.util.Map<String, Object> extra) {
            this.extra = extra;
        }

        /**
         * 设置额外的元数据
         */
        public void setExtra(String key, Object value) {
            if (extra == null) {
                extra = new java.util.HashMap<>();
            }
            extra.put(key, value);
        }

        /**
         * 获取额外的元数据
         */
        public Object getExtra(String key) {
            return extra != null ? extra.get(key) : null;
        }

        public static class Block {
            private String type;
            private Object content;

            public Block() {
            }

            public String getType() {
                return type;
            }

            public void setType(String type) {
                this.type = type;
            }

            public Object getContent() {
                return content;
            }

            public void setContent(Object content) {
                this.content = content;
            }
        }
    }

    /**
     * 元数据
     */
    public static class Meta {
        private boolean streaming;

        public Meta() {
        }

        public boolean isStreaming() {
            return streaming;
        }

        public void setStreaming(boolean streaming) {
            this.streaming = streaming;
        }
    }

    /**
     * 事件负载
     */
    public static class Payload {
        private String nonce;
        private long ts;

        public Payload() {
        }

        public String getNonce() {
            return nonce;
        }

        public void setNonce(String nonce) {
            this.nonce = nonce;
        }

        public long getTs() {
            return ts;
        }

        public void setTs(long ts) {
            this.ts = ts;
        }
    }
}
