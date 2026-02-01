package cn.wildfirechat.client.protocol;

/**
 * 响应消息（网关 &rarr; 客户端）
 */
public class ResponseMessage {
    private String requestId;
    private int code;
    private String msg;
    private Object result;

    public ResponseMessage() {
    }

    public String getRequestId() {
        return requestId;
    }

    public void setRequestId(String requestId) {
        this.requestId = requestId;
    }

    public int getCode() {
        return code;
    }

    public void setCode(int code) {
        this.code = code;
    }

    public String getMsg() {
        return msg;
    }

    public void setMsg(String msg) {
        this.msg = msg;
    }

    public Object getResult() {
        return result;
    }

    public void setResult(Object result) {
        this.result = result;
    }

    public boolean isSuccess() {
        return code == 0;
    }
}
