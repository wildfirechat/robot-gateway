package cn.wildfirechat.app.protocol;

/**
 * 响应消息（网关 &rarr; 客户端）
 */
public class ResponseMessage {
    /**
     * 对应的请求ID
     */
    private String requestId;

    /**
     * 状态码，0表示成功
     */
    private int code;

    /**
     * 消息描述
     */
    private String msg;

    /**
     * 结果数据
     */
    private Object result;

    public ResponseMessage() {
    }

    public ResponseMessage(String requestId, int code, String msg, Object result) {
        this.requestId = requestId;
        this.code = code;
        this.msg = msg;
        this.result = result;
    }

    public static ResponseMessage success(String requestId, Object result) {
        return new ResponseMessage(requestId, 0, "success", result);
    }

    public static ResponseMessage error(String requestId, int code, String msg) {
        return new ResponseMessage(requestId, code, msg, null);
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

    @Override
    public String toString() {
        return "ResponseMessage{" +
                "requestId='" + requestId + '\'' +
                ", code=" + code +
                ", msg='" + msg + '\'' +
                ", result=" + result +
                '}';
    }
}
