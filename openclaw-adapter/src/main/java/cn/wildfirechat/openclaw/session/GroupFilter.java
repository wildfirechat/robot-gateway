package cn.wildfirechat.openclaw.session;

import cn.wildfirechat.openclaw.config.GroupStrategyConfig;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawOutMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 群聊过滤器
 * 实现群聊防刷屏策略，避免机器人在群聊中过度响应
 */
@Component
public class GroupFilter {
    private static final Logger LOG = LoggerFactory.getLogger(GroupFilter.class);

    @Autowired
    private GroupStrategyConfig config;

    /**
     * 判断是否应该响应群聊消息
     *
     * @param message    消息
     * @param robotId    机器人ID（用于检测是否被@）
     * @return true=应该响应, false=不响应
     */
    public boolean shouldRespond(OpenclawOutMessage message, String robotId) {
        // 如果不是群聊，直接返回true（私聊总是响应）
        if (!message.getChannel().isGroup()) {
            return true;
        }

        // 如果群聊策略未启用，不响应群聊
        if (!config.isEnabled()) {
            LOG.debug("Group strategy is disabled, ignoring group message");
            return false;
        }

        // 策略1：被@时回复
        if (config.isRespondOnMention() && isMentioned(message, robotId)) {
            LOG.debug("Bot is mentioned in group, will respond");
            return true;
        }

        // 策略2：消息以问号结尾
        if (config.isRespondOnQuestion()) {
            String text = message.getMessage().getText();
            if (text != null && text.matches(".*[？?]$")) {
                LOG.debug("Message ends with question mark, will respond");
                return true;
            }
        }

        // 策略3：包含求助关键词
        String text = message.getMessage().getText();
        if (text != null) {
            List<String> keywords = config.getHelpKeywordList();
            for (String keyword : keywords) {
                if (text.contains(keyword.trim())) {
                    LOG.debug("Message contains help keyword '{}', will respond", keyword);
                    return true;
                }
            }
        }

        // 策略4：群聊白名单
        List<String> allowedGroups = config.getAllowedIdList();
        if (!allowedGroups.isEmpty() && allowedGroups.contains(message.getChannel().getThreadId())) {
            LOG.debug("Group is in whitelist, will respond");
            return true;
        }

        // 默认不响应群聊
        LOG.debug("Group message does not match any response criteria, ignoring");
        return false;
    }

    /**
     * 检测消息是否提及了机器人
     */
    private boolean isMentioned(OpenclawOutMessage message, String robotId) {
        if (robotId == null || message.getMessage().getMentions() == null) {
            return false;
        }

        for (OpenclawOutMessage.Message.Mention mention : message.getMessage().getMentions()) {
            if (robotId.equals(mention.getId())) {
                return true;
            }
        }

        return false;
    }
}
