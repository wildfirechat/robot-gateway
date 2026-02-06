package cn.wildfirechat.openclaw.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * 会话配置
 */
@Configuration
@ConfigurationProperties(prefix = "openclaw.session")
public class SessionConfig {
    /**
     * 会话超时时间（毫秒），默认30分钟
     */
    private long timeout = 1800000;

    /**
     * 最大会话数
     */
    private int maxSessions = 1000;

    public long getTimeout() {
        return timeout;
    }

    public void setTimeout(long timeout) {
        this.timeout = timeout;
    }

    public int getMaxSessions() {
        return maxSessions;
    }

    public void setMaxSessions(int maxSessions) {
        this.maxSessions = maxSessions;
    }
}
