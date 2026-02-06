package cn.wildfirechat.openclaw.openclaw.protocol;

import java.util.List;

/**
 * 发送到Openclaw Gateway的消息
 */
public class OpenclawOutMessage {
    /**
     * 消息类型：固定为"message"
     */
    private String type = "message";

    /**
     * 通道信息
     */
    private Channel channel;

    /**
     * 消息内容
     */
    private Message message;

    /**
     * 会话信息（可选）
     */
    private Session session;

    public OpenclawOutMessage() {
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
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

    public Session getSession() {
        return session;
    }

    public void setSession(Session session) {
        this.session = session;
    }

    /**
     * 通道信息
     */
    public static class Channel {
        private String id = "wildfire-im";
        private String threadId;
        private String peerId;
        private String peerName;
        private boolean isGroup;

        public Channel() {
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
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

        public String getPeerName() {
            return peerName;
        }

        public void setPeerName(String peerName) {
            this.peerName = peerName;
        }

        public boolean isGroup() {
            return isGroup;
        }

        public void setGroup(boolean group) {
            isGroup = group;
        }
    }

    /**
     * 消息内容
     */
    public static class Message {
        private String id;
        private String text;
        private long timestamp;
        private List<Mention> mentions;

        public Message() {
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getText() {
            return text;
        }

        public void setText(String text) {
            this.text = text;
        }

        public long getTimestamp() {
            return timestamp;
        }

        public void setTimestamp(long timestamp) {
            this.timestamp = timestamp;
        }

        public List<Mention> getMentions() {
            return mentions;
        }

        public void setMentions(List<Mention> mentions) {
            this.mentions = mentions;
        }

        public static class Mention {
            private String id;
            private String name;

            public Mention() {
            }

            public Mention(String id, String name) {
                this.id = id;
                this.name = name;
            }

            public String getId() {
                return id;
            }

            public void setId(String id) {
                this.id = id;
            }

            public String getName() {
                return name;
            }

            public void setName(String name) {
                this.name = name;
            }
        }
    }

    /**
     * 会话信息
     */
    public static class Session {
        private String id;

        public Session() {
        }

        public Session(String id) {
            this.id = id;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }
    }
}
