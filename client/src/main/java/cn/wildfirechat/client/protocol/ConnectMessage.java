package cn.wildfirechat.client.protocol;

/**
 * 鉴权消息（客户端 &harr; 网关）
 */
public class ConnectMessage {
    private String type;
    private String robotId;
    private String secret;
    /**
     * 机器人 SDK 所在平台（野火 Platform 号，见 ProtoConstants.Platform：
     * 7=Linux, 5=WEB, 1=iOS, 2=Android, 10=Harmony ...）。
     * 网关用它调用 im-server `/robot/set_online` 设置机器人在正确平台在线。
     */
    private Integer platform;
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

    /**
     * 创建鉴权请求（带平台号）
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @param platform 机器人平台号，null 时网关按默认平台处理
     * @return 鉴权消息
     */
    public static ConnectMessage request(String robotId, String secret, Integer platform) {
        ConnectMessage msg = new ConnectMessage("connect", robotId, secret);
        msg.setPlatform(platform);
        return msg;
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

    public Integer getPlatform() {
        return platform;
    }

    public void setPlatform(Integer platform) {
        this.platform = platform;
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
