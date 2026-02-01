package cn.wildfirechat.client.handler;

import cn.wildfirechat.client.protocol.PushMessage;

/**
 * 消息处理器接口
 * 处理网关推送的消息
 */
public interface MessageHandler {

    /**
     * 处理接收到的消息
     * @param message 推送的消息
     */
    void onMessage(PushMessage message);

    /**
     * 处理连接事件
     * @param connected 是否连接成功
     */
    default void onConnectionChanged(boolean connected) {
    }

    /**
     * 处理错误
     * @param error 错误信息
     */
    default void onError(String error) {
    }
}
