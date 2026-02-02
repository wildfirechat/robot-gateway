package cn.wildfirechat.app.service;

import cn.wildfirechat.app.config.BotFatherConfig;
import cn.wildfirechat.common.ErrorCode;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.sdk.RelationAdmin;
import cn.wildfirechat.sdk.UserAdmin;
import cn.wildfirechat.sdk.model.IMResult;
import cn.wildfirechat.sdk.utilities.AdminHttpUtils;
import io.netty.util.internal.StringUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import javax.annotation.PostConstruct;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * RobotFather 服务类
 * 负责自动创建和管理机器人
 */
@Service
public class RobotFatherService {
    private static final Logger LOG = LoggerFactory.getLogger(RobotFatherService.class);

    @Autowired
    private BotFatherConfig botFatherConfig;

    // 内存缓存：用户ID -> 机器人信息
    private final Map<String, RobotInfo> userRobotCache = new HashMap<>();

    @PostConstruct
    private void init() {
        // 验证公网地址配置
        if (botFatherConfig.getPublicAddr() == null || botFatherConfig.getPublicAddr().isEmpty()) {
            LOG.error("BotFather public address is not configured! Please set botfather.publicAddr in application.properties");
        }

        // 初始化Server APIHTTP工具
        try {
            AdminHttpUtils.init(botFatherConfig.getAdmin().getUrl(),
                              botFatherConfig.getAdmin().getSecret());
            LOG.info("AdminHttpUtils initialized with url: {}", botFatherConfig.getAdmin().getUrl());
        } catch (Exception e) {
            LOG.error("Failed to initialize AdminHttpUtils", e);
        }
    }

    /**
     * 获取或创建用户的机器人
     * @param userId 用户ID
     * @return 机器人信息
     */
    public RobotInfo getOrCreateRobot(String userId) {
        // 先从缓存查找
        RobotInfo cached = userRobotCache.get(userId);
        if (cached != null) {
            LOG.info("Found cached robot for user: {}, robotId: {}", userId, cached.getRobotId());
            return cached;
        }

        try {
//            // 调用SDK查询用户的机器人列表
            IMResult<OutputStringList> result = UserAdmin.getUserRobots(userId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputStringList robotList = result.getResult();
                if (robotList != null && robotList.getList() != null && !robotList.getList().isEmpty()) {
                    // 用户已有机器人，获取第一个机器人的详细信息
                    String robotId = robotList.getList().get(0);
                    LOG.info("User {} already has robot: {}", userId, robotId);

                    // 获取机器人详细信息
                    IMResult<OutputRobot> robotResult = UserAdmin.getRobotInfo(robotId);
                    if (robotResult != null && robotResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                        OutputRobot robot = robotResult.getResult();
                        if (robot != null) {
                            if(!StringUtil.isNullOrEmpty(botFatherConfig.getCallbackUrl()) && botFatherConfig.getCallbackUrl().equals(robot.getCallback())) {
                                robot.setCallback(botFatherConfig.getCallbackUrl());
                                InputCreateRobot createRobot = new InputCreateRobot();
                                createRobot.setUserId(robot.getUserId());
                                createRobot.setName(robot.getName());
                                createRobot.setPassword(robot.getPassword());
                                createRobot.setDisplayName(robot.getDisplayName());
                                createRobot.setPortrait(robot.getPortrait());
                                createRobot.setGender(robot.getGender());
                                createRobot.setMobile(robot.getMobile());
                                createRobot.setEmail(robot.getEmail());
                                createRobot.setAddress(robot.getAddress());
                                createRobot.setCompany(robot.getCompany());
                                createRobot.setSocial(robot.getSocial());
                                createRobot.setExtra(robot.getExtra());
                                createRobot.setOwner(robot.getOwner());
                                createRobot.setSecret(robot.getSecret());
                                createRobot.setCallback(robot.getCallback());
                                createRobot.setRobotExtra(robot.getRobotExtra());
                                UserAdmin.createRobot(createRobot);
                            }
                            RobotInfo info = new RobotInfo(robot.getUserId(), robot.getSecret());
                            // 缓存机器人信息
                            userRobotCache.put(userId, info);
                            addRobotFriend(userId, robot.getUserId());
                            return info;
                        }
                    }
                }
            }

            // 用户没有机器人，创建新机器人
            return createRobot(userId);

        } catch (Exception e) {
            LOG.error("Failed to get or create robot for user: {}", userId, e);
            return null;
        }
    }

    private void addRobotFriend(String robotId, String userId) {
        try {
            RelationAdmin.setUserFriend(userId, robotId, true, null);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /**
     * 为用户创建新机器人
     * 回调地址自动使用配置文件中的 botfather.callbackUrl
     *
     * @param userId 用户ID
     * @return 新创建的机器人信息
     */
    private RobotInfo createRobot(String userId) {
        try {
            LOG.info("Creating new robot for user: {}", userId);

            String userName = "私有";
            IMResult<InputOutputUserInfo> imResult = UserAdmin.getUserByUserId(userId);
            if(imResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                userName = imResult.getResult().getDisplayName();
            }

            // 生成机器人信息
            String robotId = "robot_" + userId + "_" + System.currentTimeMillis();
            String robotSecret = generateSecret();

            // 构建创建机器人请求
            InputCreateRobot input = new InputCreateRobot();
            input.setUserId(robotId);
            input.setName(robotId);
            input.setDisplayName(userName+" 的机器人");
            input.setOwner(userId);
            input.setSecret(robotSecret);

            // ========== 自动设置回调地址 ==========
            String callbackUrl = botFatherConfig.getCallbackUrl();
            if (callbackUrl != null && !callbackUrl.isEmpty()) {
                input.setCallback(callbackUrl);
                LOG.info("Setting callback URL for robot: {}", callbackUrl);
            } else {
                LOG.warn("Callback URL is not configured, robot will be created without callback");
            }
            // ======================================

            // 调用SDK创建机器人
            IMResult<OutputCreateRobot> result = UserAdmin.createRobot(input);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputCreateRobot output = result.getResult();
                if (output != null) {
                    RobotInfo info = new RobotInfo(output.getUserId(), output.getSecret());
                    // 缓存机器人信息
                    userRobotCache.put(userId, info);
                    LOG.info("Robot created successfully for user: {}, robotId: {}", userId, output.getUserId());
                    addRobotFriend(userId, info.getRobotId());
                    return info;
                }
            } else {
                LOG.error("Failed to create robot, error: {}", result != null ? result.getCode() : "null");
            }

        } catch (Exception e) {
            LOG.error("Exception when creating robot for user: {}", userId, e);
        }

        return null;
    }

    /**
     * 生成随机密钥
     * @return 密钥字符串
     */
    private String generateSecret() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    /**
     * 获取用户当前的机器人
     * 如果缓存为空，会从 IM 服务器重新加载
     *
     * @param userId 用户ID
     * @return 机器人信息，如果用户没有机器人则返回null
     */
    public RobotInfo getUserCurrentRobot(String userId) {
        // 先从缓存查找
        RobotInfo cached = userRobotCache.get(userId);
        if (cached != null) {
            return cached;
        }

        // 缓存为空，从服务器重新加载
        LOG.info("Cache is empty for user: {}, reloading from server", userId);
        return reloadRobotFromServer(userId);
    }

    /**
     * 从 IM 服务器重新加载机器人信息
     *
     * @param userId 用户ID
     * @return 机器人信息，如果用户没有机器人则返回null
     */
    private RobotInfo reloadRobotFromServer(String userId) {
        try {
            // 调用SDK查询用户的机器人列表
            IMResult<OutputStringList> result = UserAdmin.getUserRobots(userId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputStringList robotList = result.getResult();
                if (robotList != null && robotList.getList() != null && !robotList.getList().isEmpty()) {
                    // 用户已有机器人，获取第一个机器人的详细信息
                    String robotId = robotList.getList().get(0);
                    LOG.info("Found robot on server for user: {}, robotId: {}", userId, robotId);

                    // 获取机器人详细信息
                    IMResult<OutputRobot> robotResult = UserAdmin.getRobotInfo(robotId);
                    if (robotResult != null && robotResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                        OutputRobot robot = robotResult.getResult();
                        if (robot != null) {
                            RobotInfo info = new RobotInfo(robot.getUserId(), robot.getSecret());
                            // 缓存机器人信息
                            userRobotCache.put(userId, info);
                            return info;
                        }
                    }
                }
            }

            // 用户没有机器人
            LOG.info("No robot found on server for user: {}", userId);
            return null;

        } catch (Exception e) {
            LOG.error("Failed to reload robot from server for user: {}", userId, e);
            return null;
        }
    }

    /**
     * 清除用户缓存
     * @param userId 用户ID
     */
    public void clearUserCache(String userId) {
        userRobotCache.remove(userId);
    }

    /**
     * 更新机器人密钥（仅更新缓存）
     * @param userId 用户ID
     * @param newSecret 新密钥
     */
    public void updateRobotSecret(String userId, String newSecret) {
        RobotInfo info = userRobotCache.get(userId);
        if (info != null) {
            RobotInfo newInfo = new RobotInfo(info.getRobotId(), newSecret);
            userRobotCache.put(userId, newInfo);
        }
    }

    /**
     * 机器人信息类
     */
    public static class RobotInfo {
        private final String robotId;
        private final String robotSecret;

        public RobotInfo(String robotId, String robotSecret) {
            this.robotId = robotId;
            this.robotSecret = robotSecret;
        }

        public String getRobotId() {
            return robotId;
        }

        public String getRobotSecret() {
            return robotSecret;
        }
    }
}
