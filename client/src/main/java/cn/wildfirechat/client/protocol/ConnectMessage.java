package cn.wildfirechat.client.protocol;

/**
 * 鉴权消息（客户端 &harr; 网关）
 */
public class ConnectMessage {
    private String type;
    private String robotId;
    private String secret;
    private Integer code;
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
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @return 鉴权消息
     */
    public static ConnectMessage request(String robotId, String secret) {
        return new ConnectMessage("connect", robotId, secret);
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

    public boolean isSuccess() {
        return code != null && code == 0;
    }
}
