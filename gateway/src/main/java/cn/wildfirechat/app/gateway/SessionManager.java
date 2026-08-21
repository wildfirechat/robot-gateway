package cn.wildfirechat.app.gateway;

import cn.wildfirechat.sdk.RobotService;
import cn.wildfirechat.sdk.model.IMResult;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.CloseStatus;

import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executor;

/**
 * WebSocket会话管理器
 * 管理所有连接的客户端会话，支持鉴权和多机器人实例
 */
@Component
public class SessionManager {
    private static final Logger LOG = LoggerFactory.getLogger(SessionManager.class);

    private final Gson gson = new Gson();

    /**
     * 存储所有活跃的WebSocket会话
     */
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    /**
     * 会话信息
     */
    private final Map<String, SessionInfo> sessionInfos = new ConcurrentHashMap<>();

    /**
     * 机器人ID到sessionId集合的映射
     */
    private final Map<String, Set<String>> robotSessionMap = new ConcurrentHashMap<>();

    // 心跳超时时间（毫秒）- 5分钟
    private static final long HEARTBEAT_TIMEOUT = 5 * 60 * 1000;

    // 未鉴权会话超时时间（毫秒）- 1分钟
    private static final long UNAUTHENTICATED_TIMEOUT = 60 * 1000;

    // 机器人在线状态对应的平台号
    private static final int ROBOT_ONLINE_PLATFORM = 7;

    @Autowired
    private Executor asyncExecutor;

    @PostConstruct
    public void init() {
        LOG.info("SessionManager initialized");
    }

    /**
     * 添加会话（未鉴权状态）
     */
    public void addSession(WebSocketSession session) {
        String sessionId = session.getId();
        sessions.put(sessionId, session);
        sessionInfos.put(sessionId, new SessionInfo(sessionId));
        LOG.info("Session added: {}, total sessions: {}", sessionId, sessions.size());
    }

    /**
     * 移除会话
     */
    public void removeSession(WebSocketSession session) {
        if (session == null) {
            return;
        }
        removeSessionById(session.getId());
    }

    /**
     * 通过sessionId移除会话
     */
    private void removeSessionById(String sessionId) {
        SessionInfo info = sessionInfos.remove(sessionId);
        WebSocketSession session = sessions.remove(sessionId);

        if (info != null && info.getRobotId() != null) {
            Set<String> robotSessions = robotSessionMap.get(info.getRobotId());
            boolean isLastSession = false;
            if (robotSessions != null) {
                robotSessions.remove(sessionId);
                if (robotSessions.isEmpty()) {
                    robotSessionMap.remove(info.getRobotId());
                    isLastSession = true;
                }
            }
            // 如果是最后一个会话，先同步通知 IMSDK 设置机器人下线，避免 RobotService 关闭后无法发送
            if (isLastSession && info.getRobotService() != null) {
                try {
                    IMResult<Void> result = info.getRobotService().setOnline(ROBOT_ONLINE_PLATFORM, false);
                    LOG.info("Set robot {} online status to false on platform {}: {}",
                            info.getRobotId(), ROBOT_ONLINE_PLATFORM,
                            result != null ? result.getErrorCode() : "null");
                } catch (Exception e) {
                    LOG.error("Failed to set robot {} online status to false: {}", info.getRobotId(), e.getMessage());
                }
            }
            // 关闭RobotService
            if (info.getRobotService() != null) {
                try {
                    info.getRobotService().close();
                } catch (Exception e) {
                    LOG.error("Failed to close robot service: {}", e.getMessage());
                }
            }
        }

        // 关闭WebSocket连接
        if (session != null && session.isOpen()) {
            try {
                session.close();
            } catch (IOException e) {
                LOG.error("Failed to close session {}: {}", sessionId, e.getMessage());
            }
        }

        LOG.info("Session removed: {}, total sessions: {}", sessionId, sessions.size());
    }

    /**
     * 鉴权会话
     */
    public boolean authenticateSession(String sessionId, String robotId, RobotService robotService) {
        SessionInfo info = sessionInfos.get(sessionId);
        if (info == null) {
            LOG.warn("Session {} not found for authentication", sessionId);
            return false;
        }

        // 单连接语义：机器人重连即接管——先踢掉该机器人残留的旧会话。
        // 否则每条消息会被投递给每个存活会话（重复投递，可并发写坏会话日志）。
        Set<String> existing = robotSessionMap.get(robotId);
        if (existing != null) {
            for (String oldSessionId : new ArrayList<>(existing)) {
                if (oldSessionId.equals(sessionId)) {
                    continue;
                }
                WebSocketSession oldSession = sessions.get(oldSessionId);
                removeSessionById(oldSessionId);
                if (oldSession != null && oldSession.isOpen()) {
                    try {
                        oldSession.close(CloseStatus.NORMAL.withReason("replaced by new robot connection"));
                    } catch (IOException e) {
                        LOG.warn("Failed to close stale session {} for robot {}: {}",
                                oldSessionId, robotId, e.getMessage());
                    }
                }
                LOG.info("Evicted stale session {} for robot {} (reconnected)", oldSessionId, robotId);
            }
        }

        info.setAuthenticated(true);
        info.setRobotId(robotId);
        info.setRobotService(robotService);

        robotSessionMap.computeIfAbsent(robotId, k -> new CopyOnWriteArraySet<>()).add(sessionId);

        // 通知 IMSDK 设置机器人在线
        setRobotOnlineAsync(robotService, robotId, true);

        LOG.info("Session {} authenticated as robot {}", sessionId, robotId);
        return true;
    }

    /**
     * 检查会话是否已鉴权
     */
    public boolean isAuthenticated(String sessionId) {
        SessionInfo info = sessionInfos.get(sessionId);
        return info != null && info.isAuthenticated();
    }

    /**
     * 获取会话的机器人ID
     */
    public String getRobotId(String sessionId) {
        SessionInfo info = sessionInfos.get(sessionId);
        return info != null ? info.getRobotId() : null;
    }

    /**
     * 获取会话的RobotService实例
     */
    public RobotService getRobotService(String sessionId) {
        SessionInfo info = sessionInfos.get(sessionId);
        return info != null ? info.getRobotService() : null;
    }

    /**
     * 通过机器人ID获取所有会话
     * 返回的是快照，避免遍历期间的并发修改问题
     */
    public Set<WebSocketSession> getSessionsByRobotId(String robotId) {
        Set<WebSocketSession> result = new java.util.HashSet<>();
        Set<String> sessionIds = robotSessionMap.get(robotId);
        if (sessionIds == null || sessionIds.isEmpty()) {
            return result;
        }

        // 创建快照以避免在发送消息期间会话被关闭
        List<String> sessionIdSnapshot = new ArrayList<>(sessionIds);
        for (String sessionId : sessionIdSnapshot) {
            WebSocketSession session = sessions.get(sessionId);
            if (session != null && session.isOpen()) {
                result.add(session);
            }
        }
        return result;
    }

    /**
     * 发送消息到指定会话
     */
    public boolean sendMessage(WebSocketSession session, Object message) {
        if (session != null && session.isOpen()) {
            try {
                String json = gson.toJson(message);
                session.sendMessage(new TextMessage(json));
                return true;
            } catch (IOException e) {
                LOG.error("Failed to send message to session {}: {}", session.getId(), e.getMessage());
                // 主动关闭 session，防止 Tomcat WebSocket 底层 socket 泄漏导致 CLOSE_WAIT
                try {
                    session.close();
                } catch (IOException ex) {
                    LOG.error("Failed to close session {} after send error: {}", session.getId(), ex.getMessage());
                }
                return false;
            }
        }
        return false;
    }

    /**
     * 发送消息到指定机器人
     */
    public boolean sendMessageToRobot(String robotId, Object message) {
        Set<WebSocketSession> robotSessions = getSessionsByRobotId(robotId);
        if (robotSessions.isEmpty()) {
            LOG.warn("Robot {} has no active sessions", robotId);
            return false;
        }

        boolean allSuccess = true;
        for (WebSocketSession session : robotSessions) {
            if (!sendMessage(session, message)) {
                allSuccess = false;
            }
        }
        return allSuccess;
    }

    /**
     * 获取当前会话数量
     */
    public int getSessionCount() {
        return sessions.size();
    }

    /**
     * 检查会话是否存在且打开
     */
    public boolean hasSession(String sessionId) {
        WebSocketSession session = sessions.get(sessionId);
        return session != null && session.isOpen();
    }

    /**
     * 关闭所有会话
     */
    public void closeAll() {
        for (WebSocketSession session : new ArrayList<>(sessions.values())) {
            try {
                if (session.isOpen()) {
                    session.close();
                }
            } catch (IOException e) {
                LOG.error("Failed to close session: {}", e.getMessage());
            }
        }
        for (SessionInfo info : sessionInfos.values()) {
            if (info.getRobotService() != null) {
                try {
                    info.getRobotService().close();
                } catch (Exception e) {
                    LOG.error("Failed to close robot service: {}", e.getMessage());
                }
            }
        }
        sessions.clear();
        sessionInfos.clear();
        robotSessionMap.clear();
        LOG.info("All sessions closed");
    }

    @PreDestroy
    public void destroy() {
        closeAll();
        LOG.info("SessionManager destroyed");
    }

    /**
     * 会话信息
     */
    public static class SessionInfo {
        private final String sessionId;
        private boolean authenticated;
        private String robotId;
        private RobotService robotService;
        private volatile long lastHeartbeatTime;
        private final long createTime;

        public SessionInfo(String sessionId) {
            this.sessionId = sessionId;
            this.authenticated = false;
            this.lastHeartbeatTime = System.currentTimeMillis();
            this.createTime = System.currentTimeMillis();
        }

        public long getCreateTime() { return createTime; }

        public String getSessionId() { return sessionId; }
        public boolean isAuthenticated() { return authenticated; }
        public void setAuthenticated(boolean authenticated) { this.authenticated = authenticated; }
        public String getRobotId() { return robotId; }
        public void setRobotId(String robotId) { this.robotId = robotId; }
        public RobotService getRobotService() { return robotService; }
        public void setRobotService(RobotService robotService) { this.robotService = robotService; }
        public long getLastHeartbeatTime() { return lastHeartbeatTime; }
        public void updateHeartbeatTime() { this.lastHeartbeatTime = System.currentTimeMillis(); }
    }

    /**
     * 通过会话ID获取机器人ID
     */
    public String getRobotIdBySession(String sessionId) {
        return getRobotId(sessionId);
    }

    /**
     * 异步设置机器人在线状态
     */
    private void setRobotOnlineAsync(RobotService robotService, String robotId, boolean online) {
        if (robotService == null || asyncExecutor == null) {
            return;
        }
        asyncExecutor.execute(() -> {
            try {
                IMResult<Void> result = robotService.setOnline(ROBOT_ONLINE_PLATFORM, online);
                LOG.info("Set robot {} online status to {} on platform {}: {}",
                        robotId, online, ROBOT_ONLINE_PLATFORM,
                        result != null ? result.getErrorCode() : "null");
            } catch (Exception e) {
                LOG.error("Failed to set robot {} online status to {}: {}", robotId, online, e.getMessage());
            }
        });
    }

    /**
     * 更新指定会话的机器人在线状态
     */
    public void updateRobotOnlineStatus(String sessionId, boolean online) {
        SessionInfo info = sessionInfos.get(sessionId);
        if (info != null && info.getRobotService() != null) {
            setRobotOnlineAsync(info.getRobotService(), info.getRobotId(), online);
        }
    }

    /**
     * 更新心跳时间
     */
    public void updateHeartbeatTime(String sessionId) {
        SessionInfo info = sessionInfos.get(sessionId);
        if (info != null) {
            info.updateHeartbeatTime();
        }
    }

    /**
     * 定时清理超时的心跳会话（已鉴权）和未鉴权会话
     * 每60秒执行一次
     */
    @Scheduled(fixedRate = 60000)
    public void cleanupExpiredSessions() {
        long now = System.currentTimeMillis();
        int expiredCount = 0;
        int unauthCount = 0;
        List<String> toRemove = new ArrayList<>();

        for (Map.Entry<String, SessionInfo> entry : sessionInfos.entrySet()) {
            SessionInfo info = entry.getValue();
            if (info.isAuthenticated()) {
                // 清理已鉴权但超时的会话
                long lastHeartbeat = info.getLastHeartbeatTime();
                if (now - lastHeartbeat > HEARTBEAT_TIMEOUT) {
                    toRemove.add(entry.getKey());
                    expiredCount++;
                }
            } else {
                // 清理未鉴权且超时的会话
                long createTime = info.getCreateTime();
                if (now - createTime > UNAUTHENTICATED_TIMEOUT) {
                    toRemove.add(entry.getKey());
                    unauthCount++;
                }
            }
        }

        for (String sessionId : toRemove) {
            removeSessionById(sessionId);
        }

        if (expiredCount > 0 || unauthCount > 0) {
            LOG.info("Cleaned up {} expired (heartbeat) and {} unauthenticated sessions, remaining: {}", 
                    expiredCount, unauthCount, sessions.size());
        }
    }

    /**
     * 获取指定机器人的连接数
     */
    public int getConnectionCount(String robotId) {
        Set<String> sessionIds = robotSessionMap.get(robotId);
        if (sessionIds == null) {
            return 0;
        }
        return (int) sessionIds.stream()
                .filter(sid -> {
                    WebSocketSession s = sessions.get(sid);
                    return s != null && s.isOpen();
                })
                .count();
    }
}
