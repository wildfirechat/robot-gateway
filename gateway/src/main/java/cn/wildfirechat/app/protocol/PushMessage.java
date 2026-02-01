package cn.wildfirechat.app.protocol;

import cn.wildfirechat.pojos.OutputMessageData;

/**
 * 推送消息（网关 &rarr; 客户端）
 */
public class PushMessage {
    /**
     * 消息类型
     * "message" - 普通消息推送
     * "event" - 事件通知
     */
    private String type;

    /**
     * 消息数据
     */
    private OutputMessageData data;

    /**
     * 事件类型（当type="event"时使用）
     */
    private String event;

    /**
     * 额外数据
     */
    private Object extra;

    public PushMessage() {
    }

    public PushMessage(String type, OutputMessageData data) {
        this.type = type;
        this.data = data;
    }

    public static PushMessage message(OutputMessageData data) {
        return new PushMessage("message", data);
    }

    public static PushMessage event(String event, Object extra) {
        PushMessage msg = new PushMessage("event", null);
        msg.setEvent(event);
        msg.setExtra(extra);
        return msg;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public OutputMessageData getData() {
        return data;
    }

    public void setData(OutputMessageData data) {
        this.data = data;
    }

    public String getEvent() {
        return event;
    }

    public void setEvent(String event) {
        this.event = event;
    }

    public Object getExtra() {
        return extra;
    }

    public void setExtra(Object extra) {
        this.extra = extra;
    }

    @Override
    public String toString() {
        return "PushMessage{" +
                "type='" + type + '\'' +
                ", data=" + data +
                ", event='" + event + '\'' +
                ", extra=" + extra +
                '}';
    }
}
