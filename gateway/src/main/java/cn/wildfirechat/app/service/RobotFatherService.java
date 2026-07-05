package cn.wildfirechat.app.service;

import cn.wildfirechat.app.config.BotFatherConfig;
import cn.wildfirechat.common.ErrorCode;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.sdk.RelationAdmin;
import cn.wildfirechat.sdk.RobotService;
import cn.wildfirechat.sdk.UserAdmin;
import cn.wildfirechat.sdk.model.IMResult;
import cn.wildfirechat.sdk.utilities.AdminHttpUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.annotation.PostConstruct;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * RobotFather 服务类
 * 负责自动创建和管理机器人
 */
@Service
public class RobotFatherService {
    private static final Logger LOG = LoggerFactory.getLogger(RobotFatherService.class);

    @Autowired
    private BotFatherConfig botFatherConfig;

    @Value("${im.url}")
    private String imUrl;

    // 内存缓存：robotId -> 机器人信息（线程安全）
    private final Map<String, RobotInfo> robotInfoCache = new ConcurrentHashMap<>();
    // 缓存过期时间：30分钟
    private final Map<String, Long> cacheTimestamp = new ConcurrentHashMap<>();
    private static final long CACHE_EXPIRY_MS = 30 * 60 * 1000;

    // 已使用的robotId集合，用于快速检查重复
    private final Set<String> usedRobotIds = ConcurrentHashMap.newKeySet();

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
     * 检查用户当前机器人数量是否达到上限（maxRobotsPerUser），未达上限则创建新机器人
     * @param userId 用户ID
     * @return 机器人信息，如果已达上限则返回 null
     */
    public RobotInfo getOrCreateRobot(String userId) {
        try {
            // 调用SDK查询用户的机器人列表
            IMResult<OutputStringList> result = UserAdmin.getUserRobots(userId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputStringList robotList = result.getResult();
                List<String> robots = (robotList != null && robotList.getList() != null) ? robotList.getList() : Collections.emptyList();

                // 检查是否达到最大数量限制
                if (robots.size() >= botFatherConfig.getMaxRobotsPerUser()) {
                    LOG.info("User {} has reached the max robot limit ({})", userId, botFatherConfig.getMaxRobotsPerUser());
                    return null;
                }

                // 用户已有机器人但未达上限
                if (!robots.isEmpty()) {
                    String robotId = robots.get(robots.size() - 1);
                    LOG.info("User {} has {} robot(s), creating new robot", userId, robots.size());
                }
            }

            // 创建新机器人
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
     * 发送欢迎消息给用户
     * 使用新创建的机器人账号发送
     *
     * @param userId    用户ID
     * @param robotId   机器人ID
     * @param robotSecret 机器人密钥
     * @param robotDisplayName 机器人显示名称
     */
    private void sendWelcomeMessage(String userId, String robotId, String robotSecret, String robotDisplayName) {
        RobotService robotService = null;
        try {
            LOG.info("Sending welcome message from robot {} to user {}", robotId, userId);

            // 创建机器人服务实例
            robotService = new RobotService(imUrl, robotId, robotSecret);

            // 构建会话（私聊）
            Conversation conversation = new Conversation();
            conversation.setType(0); // 私聊
            conversation.setLine(0);
            conversation.setTarget(userId); // 发送给创建者

            // 构建消息内容
            MessagePayload payload = new MessagePayload();
            payload.setType(1); // 文本消息
            String welcomeText = String.format(
                "你好！我是 %s。\n\n" +
                "我已经创建完成，现在可以开始为你服务了。\n" +
                "你可以直接给我发消息，我会尽力帮助你！",
                robotDisplayName
            );
            payload.setSearchableContent(welcomeText);

            // 发送消息
            IMResult<SendMessageResult> result = robotService.sendMessage(robotId, conversation, payload);

            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                LOG.info("Welcome message sent successfully from {} to {}", robotId, userId);
            } else {
                LOG.error("Failed to send welcome message, error: {}",
                    result != null ? result.getCode() : "null");
            }

        } catch (Exception e) {
            LOG.error("Exception when sending welcome message from {} to {}", robotId, userId, e);
        } finally {
            if (robotService != null) {
                try {
                    robotService.close();
                } catch (Exception e) {
                    LOG.error("Failed to close robot service: {}", e.getMessage());
                }
            }
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
            String robotId = generateUniqueRobotId(userId);
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
                    // 缓存机器人信息，以 robotId 为 key
                    cacheRobotInfo(info.getRobotId(), info);
                    LOG.info("Robot created successfully for user: {}, robotId: {}", userId, output.getUserId());
                    addRobotFriend(userId, info.getRobotId());

                    // ========== 发送欢迎消息给用户 ==========
                    sendWelcomeMessage(userId, info.getRobotId(), info.getRobotSecret(), input.getDisplayName());
                    // ======================================

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
     * 生成6位随机数字字符串
     * @return 6位随机数字字符串
     */
    private String generate6DigitRandom() {
        int num = 100000 + ThreadLocalRandom.current().nextInt(900000);
        return String.valueOf(num);
    }

    /**
     * 生成唯一的机器人ID
     * 格式：robot_{userId}_{6位随机数字}
     * @param userId 用户ID
     * @return 唯一的机器人ID
     */
    private String generateUniqueRobotId(String userId) {
        String baseId = "robot_" + userId + "_";
        int maxRetries = 100;

        for (int i = 0; i < maxRetries; i++) {
            String robotId = baseId + generate6DigitRandom();

            // 检查是否已存在
            if (!usedRobotIds.contains(robotId) && !isRobotIdExists(robotId)) {
                usedRobotIds.add(robotId);
                return robotId;
            }
        }

        LOG.warn("Failed to generate unique robot ID with random suffix, falling back to UUID");
        return baseId + UUID.randomUUID().toString().replace("-", "").substring(0, 6);
    }

    /**
     * 检查机器人ID是否已存在于IM服务器
     * @param robotId 机器人ID
     * @return 是否已存在
     */
    private boolean isRobotIdExists(String robotId) {
        try {
            IMResult<OutputRobot> result = UserAdmin.getRobotInfo(robotId);
            return result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS && result.getResult() != null;
        } catch (Exception e) {
            LOG.error("Error checking if robot ID exists: {}", robotId, e);
            return false;
        }
    }

    /**
     * 通过 robotId 获取机器人信息（带缓存）
     * @param robotId 机器人ID
     * @return 机器人信息，如果不存在返回 null
     */
    public RobotInfo getRobotById(String robotId) {
        // 先从缓存查找
        RobotInfo cached = getCachedRobotInfo(robotId);
        if (cached != null) {
            LOG.debug("Found cached robot info for robotId: {}", robotId);
            return cached;
        }

        try {
            // 从服务器获取机器人详细信息
            IMResult<OutputRobot> result = UserAdmin.getRobotInfo(robotId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputRobot robot = result.getResult();
                if (robot != null) {
                    RobotInfo info = new RobotInfo(robot.getUserId(), robot.getSecret());
                    cacheRobotInfo(robotId, info);
                    return info;
                }
            }
        } catch (Exception e) {
            LOG.error("Failed to get robot info for robotId: {}", robotId, e);
        }

        return null;
    }

    /**
     * 删除指定机器人并清理缓存
     * @param robotId 机器人ID
     * @return true 删除成功，false 删除失败
     */
    public boolean deleteRobot(String robotId) {
        try {
            LOG.info("Deleting robot: {}", robotId);
            IMResult<Void> result = UserAdmin.destroyRobot(robotId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                clearCache(robotId);
                LOG.info("Robot deleted successfully: {}", robotId);
                return true;
            } else {
                LOG.error("Failed to delete robot: {}, error: {}", robotId,
                    result != null ? result.getCode() : "null");
                return false;
            }
        } catch (Exception e) {
            LOG.error("Exception when deleting robot: {}", robotId, e);
            return false;
        }
    }

    /**
     * 校验 robotId 是否属于指定用户
     * @param robotId 机器人ID
     * @param userId 用户ID
     * @return true 属于该用户，false 不属于或机器人不存在
     */
    public boolean verifyRobotOwnership(String robotId, String userId) {
        try {
            IMResult<OutputRobot> result = UserAdmin.getRobotInfo(robotId);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputRobot robot = result.getResult();
                if (robot != null && userId.equals(robot.getOwner())) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            LOG.error("Failed to verify robot ownership: robotId={}, userId={}", robotId, userId, e);
            return false;
        }
    }

    /**
     * 缓存机器人信息（带时间戳）
     */
    private void cacheRobotInfo(String robotId, RobotInfo info) {
        robotInfoCache.put(robotId, info);
        cacheTimestamp.put(robotId, System.currentTimeMillis());
    }

    /**
     * 检查缓存是否过期
     */
    private boolean isCacheExpired(String robotId) {
        Long timestamp = cacheTimestamp.get(robotId);
        if (timestamp == null) {
            return true;
        }
        return System.currentTimeMillis() - timestamp > CACHE_EXPIRY_MS;
    }

    /**
     * 获取缓存的机器人信息，自动处理过期
     */
    public RobotInfo getCachedRobotInfo(String robotId) {
        if (isCacheExpired(robotId)) {
            robotInfoCache.remove(robotId);
            cacheTimestamp.remove(robotId);
            return null;
        }
        return robotInfoCache.get(robotId);
    }

    /**
     * 清除指定 robotId 的缓存
     * @param robotId 机器人ID
     */
    public void clearCache(String robotId) {
        robotInfoCache.remove(robotId);
        cacheTimestamp.remove(robotId);
    }

    /**
     * 清理过期缓存
     */
    public void cleanupExpiredCache() {
        long now = System.currentTimeMillis();
        int count = 0;
        for (Map.Entry<String, Long> entry : cacheTimestamp.entrySet()) {
            if (now - entry.getValue() > CACHE_EXPIRY_MS) {
                robotInfoCache.remove(entry.getKey());
                cacheTimestamp.remove(entry.getKey());
                count++;
            }
        }
        if (count > 0) {
            LOG.info("Cleaned up {} expired cache entries", count);
        }
    }

    /**
     * 更新机器人密钥（仅更新缓存）
     * @param robotId 机器人ID
     * @param newSecret 新密钥
     */
    public void updateRobotSecret(String robotId, String newSecret) {
        RobotInfo info = robotInfoCache.get(robotId);
        if (info != null) {
            RobotInfo newInfo = new RobotInfo(info.getRobotId(), newSecret);
            cacheRobotInfo(robotId, newInfo);
        }
    }

    /**
     * 重置机器人密钥
     * 生成新密钥并更新到 IM 服务器
     * @param robotId 机器人ID
     * @return 包含新密钥的机器人信息，失败返回 null
     */
    public RobotInfo resetRobotSecret(String robotId) {
        try {
            LOG.info("Resetting secret for robot: {}", robotId);

            // 获取当前机器人详细信息
            IMResult<OutputRobot> robotResult = UserAdmin.getRobotInfo(robotId);
            if (robotResult == null || robotResult.getErrorCode() != ErrorCode.ERROR_CODE_SUCCESS) {
                LOG.error("Failed to get robot info for reset: {}", robotId);
                return null;
            }

            OutputRobot robot = robotResult.getResult();
            if (robot == null) {
                LOG.error("Robot info is null for: {}", robotId);
                return null;
            }

            // 生成新密钥
            String newSecret = generateSecret();

            // 构建更新请求（使用 createRobot 来更新）
            InputCreateRobot updateRobot = new InputCreateRobot();
            updateRobot.setUserId(robot.getUserId());
            updateRobot.setName(robot.getName());
            updateRobot.setPassword(robot.getPassword());
            updateRobot.setDisplayName(robot.getDisplayName());
            updateRobot.setPortrait(robot.getPortrait());
            updateRobot.setGender(robot.getGender());
            updateRobot.setMobile(robot.getMobile());
            updateRobot.setEmail(robot.getEmail());
            updateRobot.setAddress(robot.getAddress());
            updateRobot.setCompany(robot.getCompany());
            updateRobot.setSocial(robot.getSocial());
            updateRobot.setExtra(robot.getExtra());
            updateRobot.setOwner(robot.getOwner());
            updateRobot.setSecret(newSecret);  // 新密钥
            updateRobot.setCallback(robot.getCallback());
            updateRobot.setRobotExtra(robot.getRobotExtra());

            // 调用 SDK 更新机器人
            IMResult<OutputCreateRobot> result = UserAdmin.createRobot(updateRobot);
            if (result != null && result.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                OutputCreateRobot output = result.getResult();
                if (output != null) {
                    RobotInfo newInfo = new RobotInfo(output.getUserId(), output.getSecret());
                    // 更新缓存
                    cacheRobotInfo(robotId, newInfo);
                    LOG.info("Robot secret reset successfully for: {}", robotId);
                    return newInfo;
                }
            } else {
                LOG.error("Failed to reset robot secret, error: {}", result != null ? result.getCode() : "null");
            }

        } catch (Exception e) {
            LOG.error("Exception when resetting robot secret for robotId: {}", robotId, e);
        }

        return null;
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
