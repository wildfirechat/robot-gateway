package cn.wildfirechat.moltbot.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.Arrays;
import java.util.List;

/**
 * 白名单配置
 * 只有在白名单中的用户或群组的消息才会被处理
 */
@Configuration
@ConfigurationProperties(prefix = "moltbot.whitelist")
public class WhitelistConfig {
    /**
     * 是否启用白名单
     * true=只处理白名单中的消息，false=处理所有消息
     */
    private boolean enabled = false;

    /**
     * 允许的用户ID列表（逗号分隔）
     */
    private String allowedUsers = "";

    /**
     * 允许的群组ID列表（逗号分隔）
     */
    private String allowedGroups = "";

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getAllowedUsers() {
        return allowedUsers;
    }

    public void setAllowedUsers(String allowedUsers) {
        this.allowedUsers = allowedUsers;
    }

    public String getAllowedGroups() {
        return allowedGroups;
    }

    public void setAllowedGroups(String allowedGroups) {
        this.allowedGroups = allowedGroups;
    }

    /**
     * 获取允许的用户ID列表
     */
    public List<String> getAllowedUserList() {
        if (allowedUsers == null || allowedUsers.trim().isEmpty()) {
            return Arrays.asList();
        }
        return Arrays.asList(allowedUsers.split(","));
    }

    /**
     * 获取允许的群组ID列表
     */
    public List<String> getAllowedGroupList() {
        if (allowedGroups == null || allowedGroups.trim().isEmpty()) {
            return Arrays.asList();
        }
        return Arrays.asList(allowedGroups.split(","));
    }
}
