package cn.wildfirechat.moltbot.filter;

import cn.wildfirechat.moltbot.config.WhitelistConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 白名单过滤器
 * 只处理白名单中的用户或群组的消息
 */
@Component
public class WhitelistFilter {
    private static final Logger LOG = LoggerFactory.getLogger(WhitelistFilter.class);

    @Autowired
    private WhitelistConfig config;

    /**
     * 检查消息是否应该被处理
     *
     * @param senderId 发送者用户ID
     * @param targetId 目标ID（群组ID或用户ID）
     * @param isGroup 是否为群聊
     * @return true=应该处理, false=忽略
     */
    public boolean shouldProcess(String senderId, String targetId, boolean isGroup) {
        // 如果白名单未启用，处理所有消息
        if (!config.isEnabled()) {
            return true;
        }

        // 检查用户白名单
        List<String> allowedUsers = config.getAllowedUserList();
        if (!allowedUsers.isEmpty()) {
            if (allowedUsers.contains(senderId)) {
                LOG.debug("User {} is in whitelist, will process message", senderId);
                return true;
            }
        }

        // 检查群组白名单
        if (isGroup) {
            List<String> allowedGroups = config.getAllowedGroupList();
            if (!allowedGroups.isEmpty()) {
                if (allowedGroups.contains(targetId)) {
                    LOG.debug("Group {} is in whitelist, will process message", targetId);
                    return true;
                }
            }
        }

        // 不在白名单中，记录日志并忽略
        LOG.info("Message from sender={} (target={}, isGroup={}) is not in whitelist, ignoring",
                senderId, targetId, isGroup);
        return false;
    }
}
