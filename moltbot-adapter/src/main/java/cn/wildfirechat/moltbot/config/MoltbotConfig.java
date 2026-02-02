package cn.wildfirechat.moltbot.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * Moltbot Gateway配置
 */
@Configuration
@ConfigurationProperties(prefix = "moltbot.gateway")
public class MoltbotConfig {
    /**
     * Moltbot Gateway WebSocket地址
     */
    private String url = "ws://127.0.0.1:18789";

    /**
     * 认证Token（可选）
     */
    private String token = "";

    /**
     * 通道标识
     */
    private String scope = "wildfire-im";

    /**
     * 重连间隔（毫秒）
     */
    private long reconnectInterval = 5000;

    /**
     * 心跳间隔（毫秒）
     */
    private long heartbeatInterval = 30000;

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token;
    }

    public String getScope() {
        return scope;
    }

    public void setScope(String scope) {
        this.scope = scope;
    }

    public long getReconnectInterval() {
        return reconnectInterval;
    }

    public void setReconnectInterval(long reconnectInterval) {
        this.reconnectInterval = reconnectInterval;
    }

    public long getHeartbeatInterval() {
        return heartbeatInterval;
    }

    public void setHeartbeatInterval(long heartbeatInterval) {
        this.heartbeatInterval = heartbeatInterval;
    }
}
