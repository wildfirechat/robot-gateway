package cn.wildfirechat.client.protocol;

import cn.wildfirechat.pojos.OutputMessageData;

/**
 * 推送消息（网关 &rarr; 客户端）
 */
public class PushMessage {
    private String type;
    private OutputMessageData data;
    private String event;
    private Object extra;

    public PushMessage() {
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
}
