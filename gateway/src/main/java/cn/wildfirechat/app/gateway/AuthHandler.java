package cn.wildfirechat.app.gateway;

import cn.wildfirechat.sdk.RobotService;
import cn.wildfirechat.sdk.model.IMResult;
import cn.wildfirechat.pojos.OutputRobot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 机器人鉴权处理器
 */
@Component
public class AuthHandler {

    private static final Logger LOG = LoggerFactory.getLogger(AuthHandler.class);

    @Value("${im.url}")
    public String im_url;

    /**
     * 验证机器人凭据
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @return 验证成功返回RobotService实例，失败返回null
     */
    public RobotService authenticate(String robotId, String secret) {
        RobotService robotService = null;
        try {
            LOG.info("Authenticating robot: {}", robotId);

            // 创建临时RobotService实例进行验证
            robotService = new RobotService(im_url, robotId, secret);

            // 调用getProfile验证凭据是否正确
            IMResult<OutputRobot> result = robotService.getProfile();

            if (result.getCode() == 0) {
                LOG.info("Robot {} authenticated successfully", robotId);
                return robotService;
            } else {
                LOG.warn("Robot {} authentication failed: code={}, msg={}",
                        robotId, result.getCode(), result.getMsg());
                // 鉴权失败，关闭RobotService资源
                closeRobotService(robotService);
                return null;
            }

        } catch (Exception e) {
            LOG.error("Error authenticating robot {}: {}", robotId, e.getMessage(), e);
            // 异常情况，关闭RobotService资源
            if (robotService != null) {
                closeRobotService(robotService);
            }
            return null;
        }
    }

    /**
     * 验证机器人凭据并返回结果信息
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @return [是否成功, 错误码, 错误消息]
     */
    public AuthResult authenticateWithResult(String robotId, String secret) {
        RobotService robotService = null;
        try {
            LOG.info("Authenticating robot: {}", robotId);

            robotService = new RobotService(im_url, robotId, secret);
            IMResult<OutputRobot> result = robotService.getProfile();

            if (result.getCode() == 0) {
                LOG.info("Robot {} authenticated successfully", robotId);
                return new AuthResult(true, robotService, 0, "success");
            } else {
                LOG.warn("Robot {} authentication failed: code={}, msg={}",
                        robotId, result.getCode(), result.getMsg());
                // 鉴权失败，关闭RobotService资源
                closeRobotService(robotService);
                return new AuthResult(false, null, result.getCode(), result.getMsg());
            }

        } catch (Exception e) {
            LOG.error("Error authenticating robot {}: {}", robotId, e.getMessage(), e);
            // 异常情况，关闭RobotService资源
            if (robotService != null) {
                closeRobotService(robotService);
            }
            return new AuthResult(false, null, 500, "Authentication error: " + e.getMessage());
        }
    }

    /**
     * 安全关闭RobotService
     */
    private void closeRobotService(RobotService robotService) {
        try {
            if (robotService != null) {
                robotService.close();
            }
        } catch (Exception e) {
            LOG.error("Failed to close robot service: {}", e.getMessage());
        }
    }

    /**
     * 鉴权结果
     */
    public static class AuthResult {
        private final boolean success;
        private final RobotService robotService;
        private final int code;
        private final String msg;

        public AuthResult(boolean success, RobotService robotService, int code, String msg) {
            this.success = success;
            this.robotService = robotService;
            this.code = code;
            this.msg = msg;
        }

        public boolean isSuccess() {
            return success;
        }

        public RobotService getRobotService() {
            return robotService;
        }

        public int getCode() {
            return code;
        }

        public String getMsg() {
            return msg;
        }
    }
}
