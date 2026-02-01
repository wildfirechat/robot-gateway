package cn.wildfirechat.client.protocol;

import java.util.List;

/**
 * 请求消息（客户端 &rarr; 网关）
 */
public class RequestMessage {
    private String requestId;
    private String method;
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
}
