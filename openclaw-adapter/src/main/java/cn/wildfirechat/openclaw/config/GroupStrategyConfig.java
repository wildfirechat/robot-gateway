package cn.wildfirechat.openclaw.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.Arrays;
import java.util.List;

/**
 * 群聊策略配置
 */
@Configuration
@ConfigurationProperties(prefix = "openclaw.group")
public class GroupStrategyConfig {
    /**
     * 是否启用群聊策略
     */
    private boolean enabled = true;

    /**
     * 允许回复的群聊ID列表（逗号分隔）
     */
    private String allowedIds = "";

    /**
     * 被@时回复
     */
    private boolean respondOnMention = true;

    /**
     * 问号结尾时回复
     */
    private boolean respondOnQuestion = true;

    /**
     * 求助关键词列表（逗号分隔）
     */
    private String helpKeywords = "帮,请,分析,总结,怎么,如何";

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getAllowedIds() {
        return allowedIds;
    }

    public void setAllowedIds(String allowedIds) {
        this.allowedIds = allowedIds;
    }

    public boolean isRespondOnMention() {
        return respondOnMention;
    }

    public void setRespondOnMention(boolean respondOnMention) {
        this.respondOnMention = respondOnMention;
    }

    public boolean isRespondOnQuestion() {
        return respondOnQuestion;
    }

    public void setRespondOnQuestion(boolean respondOnQuestion) {
        this.respondOnQuestion = respondOnQuestion;
    }

    public String getHelpKeywords() {
        return helpKeywords;
    }

    public void setHelpKeywords(String helpKeywords) {
        this.helpKeywords = helpKeywords;
    }

    /**
     * 获取允许的群聊ID列表
     */
    public List<String> getAllowedIdList() {
        if (allowedIds == null || allowedIds.trim().isEmpty()) {
            return Arrays.asList();
        }
        return Arrays.asList(allowedIds.split(","));
    }

    /**
     * 获取求助关键词列表
     */
    public List<String> getHelpKeywordList() {
        if (helpKeywords == null || helpKeywords.trim().isEmpty()) {
            return Arrays.asList("帮", "请", "分析", "总结", "怎么", "如何");
        }
        return Arrays.asList(helpKeywords.split(","));
    }
}
