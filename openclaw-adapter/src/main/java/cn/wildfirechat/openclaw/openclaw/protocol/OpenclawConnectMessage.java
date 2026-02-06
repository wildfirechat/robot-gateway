package cn.wildfirechat.openclaw.openclaw.protocol;

/**
 * Openclaw Gateway连接消息（Protocol 3）
 */
public class OpenclawConnectMessage {
    /**
     * 消息类型：固定为"connect"
     */
    private String type = "connect";

    /**
     * 角色：固定为"channel"
     */
    private String role = "channel";

    /**
     * 通道标识
     */
    private String scope = "wildfire-im";

    /**
     * 协议版本
     */
    private int protocol = 3;

    /**
     * 最小支持的协议版本
     */
    private int minProtocol = 3;

    /**
     * 最大支持的协议版本
     */
    private int maxProtocol = 3;

    /**
     * 认证信息（可选）
     */
    private Auth auth;

    public OpenclawConnectMessage() {
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }

    public String getScope() {
        return scope;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }

    public int getProtocol() {
        return protocol;
    }

    public void setProtocol(int protocol) {
        this.protocol = protocol;
    }

    public int getMinProtocol() {
        return minProtocol;
    }

    public void setMinProtocol(int minProtocol) {
        this.minProtocol = minProtocol;
    }

    public int getMaxProtocol() {
        return maxProtocol;
    }

    public void setMaxProtocol(int maxProtocol) {
        this.maxProtocol = maxProtocol;
    }

    public Auth getAuth() {
        return auth;
    }

    public void setAuth(Auth auth) {
        this.auth = auth;
    }

    /**
     * 认证信息
     */
    public static class Auth {
        /**
         * 认证类型：token 或 password
         */
        private String type;

        /**
         * token或password值
         */
        private String token;

        public Auth() {
        }

        public Auth(String type, String token) {
            this.type = type;
            this.token = token;
        }

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }
    }
}
