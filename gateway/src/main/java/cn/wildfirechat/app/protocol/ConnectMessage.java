package cn.wildfirechat.app.protocol;

/**
 * 鉴权消息
 */
public class ConnectMessage {
    /**
     * 消息类型，固定为"connect"
     */
    private String type;

    /**
     * 机器人ID
     */
    private String robotId;

    /**
     * 机器人密钥
     */
    private String secret;

    /**
     * 响应码（仅响应时使用）
     */
    private Integer code;

    /**
     * 响应消息（仅响应时使用）
     */
    private String msg;

    public ConnectMessage() {
    }

    public ConnectMessage(String type, String robotId, String secret) {
        this.type = type;
        this.robotId = robotId;
        this.secret = secret;
    }

    /**
     * 创建鉴权请求
     */
    public static ConnectMessage request(String robotId, String secret) {
        return new ConnectMessage("connect", robotId, secret);
    }

    /**
     * 创建成功响应
     */
    public static ConnectMessage success() {
        ConnectMessage msg = new ConnectMessage();
        msg.setType("connect");
        msg.setCode(0);
        msg.setMsg("success");
        return msg;
    }

    /**
     * 创建失败响应
     */
    public static ConnectMessage error(int code, String msg) {
        ConnectMessage m = new ConnectMessage();
        m.setType("connect");
        m.setCode(code);
        m.setMsg(msg);
        return m;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getRobotId() {
        return robotId;
    }

    public void setRobotId(String robotId) {
        this.robotId = robotId;
    }

    public String getSecret() {
        return secret;
    }

    public void setSecret(String secret) {
        this.secret = secret;
    }

    public Integer getCode() {
        return code;
    }

    public void setCode(Integer code) {
        this.code = code;
    }

    public String getMsg() {
        return msg;
    }

    public void setMsg(String msg) {
        this.msg = msg;
    }

    @Override
    public String toString() {
        return "ConnectMessage{" +
                "type='" + type + '\'' +
                ", robotId='" + robotId + '\'' +
                ", secret='***'" +
                ", code=" + code +
                ", msg='" + msg + '\'' +
                '}';
    }
}
