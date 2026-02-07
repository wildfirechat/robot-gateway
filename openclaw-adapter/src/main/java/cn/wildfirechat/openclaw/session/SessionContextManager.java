package cn.wildfirechat.openclaw.session;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话上下文管理器
 * 管理 sessionKey 到用户/群组信息的映射，用于处理 cron 等异步任务的消息回复
 */
@Component
public class SessionContextManager {
    private static final Logger LOG = LoggerFactory.getLogger(SessionContextManager.class);
    
    // sessionKey -> 会话上下文
    private final Map<String, SessionContext> sessionContexts = new ConcurrentHashMap<>();
    
    // runId -> sessionKey 的反向映射（用于清理）
    private final Map<String, String> runIdToSessionKey = new ConcurrentHashMap<>();
    
    // 默认 session key
    public static final String DEFAULT_SESSION_KEY = "main";
    
    /**
     * 会话上下文
     */
    public static class SessionContext {
        private final String senderId;
        private final String threadId;
        private final boolean isGroup;
        private final long lastActivityTime;
        
        public SessionContext(String senderId, String threadId, boolean isGroup) {
            this.senderId = senderId;
            this.threadId = threadId;
            this.isGroup = isGroup;
            this.lastActivityTime = System.currentTimeMillis();
        }
        
        public String getSenderId() {
            return senderId;
        }
        
        public String getThreadId() {
            return threadId;
        }
        
        public boolean isGroup() {
            return isGroup;
        }
        
        public long getLastActivityTime() {
            return lastActivityTime;
        }
    }
    
    /**
     * 注册会话上下文
     * 
     * @param sessionKey 会话键（如 "main"）
     * @param senderId 发送者ID
     * @param threadId 会话ID（群组ID或用户ID）
     * @param isGroup 是否群聊
     */
    public void registerSession(String sessionKey, String senderId, String threadId, boolean isGroup) {
        if (sessionKey == null || sessionKey.trim().isEmpty()) {
            sessionKey = DEFAULT_SESSION_KEY;
        }
        
        SessionContext context = new SessionContext(senderId, threadId, isGroup);
        sessionContexts.put(sessionKey, context);
        
        LOG.debug("Registered session context: sessionKey={}, senderId={}, threadId={}, isGroup={}",
                sessionKey, senderId, threadId, isGroup);
    }
    
    /**
     * 关联 runId 到 sessionKey（用于后续清理）
     * 
     * @param runId 运行ID
     * @param sessionKey 会话键
     */
    public void associateRunId(String runId, String sessionKey) {
        if (runId != null && sessionKey != null) {
            runIdToSessionKey.put(runId, sessionKey);
            LOG.debug("Associated runId {} with sessionKey {}", runId, sessionKey);
        }
    }
    
    /**
     * 获取会话上下文
     * 
     * @param sessionKey 会话键
     * @return 会话上下文，如果不存在返回 null
     */
    public SessionContext getSessionContext(String sessionKey) {
        if (sessionKey == null || sessionKey.trim().isEmpty()) {
            sessionKey = DEFAULT_SESSION_KEY;
        }
        return sessionContexts.get(sessionKey);
    }
    
    /**
     * 通过 runId 获取会话上下文
     * 
     * @param runId 运行ID
     * @return 会话上下文，如果不存在返回 null
     */
    public SessionContext getContextByRunId(String runId) {
        String sessionKey = runIdToSessionKey.get(runId);
        if (sessionKey != null) {
            return sessionContexts.get(sessionKey);
        }
        return null;
    }
    
    /**
     * 清理指定 runId 的关联
     * 
     * @param runId 运行ID
     */
    public void cleanupRunId(String runId) {
        String sessionKey = runIdToSessionKey.remove(runId);
        if (sessionKey != null) {
            LOG.debug("Cleaned up runId {} association", runId);
        }
    }
    
    /**
     * 清理过期的会话上下文
     * 
     * @param maxAgeMs 最大存活时间（毫秒）
     * @return 清理的数量
     */
    public int cleanupExpiredSessions(long maxAgeMs) {
        long now = System.currentTimeMillis();
        int count = 0;
        
        for (Map.Entry<String, SessionContext> entry : sessionContexts.entrySet()) {
            if (now - entry.getValue().getLastActivityTime() > maxAgeMs) {
                sessionContexts.remove(entry.getKey());
                count++;
            }
        }
        
        // 同时清理孤儿化的 runId 映射
        runIdToSessionKey.entrySet().removeIf(entry -> 
            !sessionContexts.containsKey(entry.getValue()));
        
        if (count > 0) {
            LOG.debug("Cleaned up {} expired session contexts", count);
        }
        return count;
    }
    
    /**
     * 获取默认会话上下文
     * 
     * @return 默认会话上下文，如果不存在返回 null
     */
    public SessionContext getDefaultSessionContext() {
        return sessionContexts.get(DEFAULT_SESSION_KEY);
    }
}
