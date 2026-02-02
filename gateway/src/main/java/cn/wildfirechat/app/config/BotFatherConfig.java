package cn.wildfirechat.app.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * BotFather 配置类
 * 用于读取 BotFather 相关的配置项
 */
@Component
@ConfigurationProperties(prefix = "botfather")
public class BotFatherConfig {

    // 功能开关
    private boolean enabled = false;

    // 机器人配置
    private Robot robot = new Robot();

    // Server API配置
    private Admin admin = new Admin();

    // 回调地址配置
    private String callbackUrl;

    // 公网地址（可选）
    private String publicAddr;

    // Getters and Setters

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public Robot getRobot() {
        return robot;
    }

    public void setRobot(Robot robot) {
        this.robot = robot;
    }

    public Admin getAdmin() {
        return admin;
    }

    public void setAdmin(Admin admin) {
        this.admin = admin;
    }

    public String getCallbackUrl() {
        return callbackUrl;
    }

    public void setCallbackUrl(String callbackUrl) {
        this.callbackUrl = callbackUrl;
    }

    public String getPublicAddr() {
        return publicAddr;
    }

    public void setPublicAddr(String publicAddr) {
        this.publicAddr = publicAddr;
    }

    /**
     * 获取 BotFather 机器人 ID（便捷方法）
     */
    public String getRobotId() {
        return robot.getId();
    }

    /**
     * 机器人配置内部类
     */
    public static class Robot {
        private String id;
        private String name;
        private String secret;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public String getSecret() {
            return secret;
        }

        public void setSecret(String secret) {
            this.secret = secret;
        }
    }

    /**
     * Server API配置内部类
     */
    public static class Admin {
        private String url;
        private String secret;

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }

        public String getSecret() {
            return secret;
        }

        public void setSecret(String secret) {
            this.secret = secret;
        }
    }
}
