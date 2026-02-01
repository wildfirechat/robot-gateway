package cn.wildfirechat.app.protocol;

import java.util.List;

/**
 * 请求消息（客户端 &rarr; 网关）
 */
public class RequestMessage {
    /**
     * 唯一请求ID，用于关联响应
     */
    private String requestId;

    /**
     * 方法名，如 "sendMessage", "getUserInfo" 等
     */
    private String method;

    /**
     * 参数列表
     */
    private List<Object> params;

    public RequestMessage() {
    }

    public RequestMessage(String requestId, String method, List<Object> params) {
        this.requestId = requestId;
        this.method = method;
        this.params = params;
    }

    public String getRequestId() {
        return requestId;
    }

    public void setRequestId(String requestId) {
        this.requestId = requestId;
    }

    public String getMethod() {
        return method;
    }

    public void setMethod(String method) {
        this.method = method;
    }

    public List<Object> getParams() {
        return params;
    }

    public void setParams(List<Object> params) {
        this.params = params;
    }

    @Override
    public String toString() {
        return "RequestMessage{" +
                "requestId='" + requestId + '\'' +
                ", method='" + method + '\'' +
                ", params=" + params +
                '}';
    }
}
