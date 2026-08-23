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

    // 机器人在线状态对应的平台号（SDK 未上报 platform 时的默认值；Linux）
    private static final int ROBOT_ONLINE_PLATFORM = 7;

    /**
     * 会话实际的在线平台号：SDK 上报的平台优先，缺省用默认平台（Linux=7）。
     */
    private static int effectivePlatform(Integer platform) {
        return platform != null ? platform : ROBOT_ONLINE_PLATFORM;
    }

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
                int platform = effectivePlatform(info.getPlatform());
                try {
                    IMResult<Void> result = info.getRobotService().setOnline(platform, false);
                    LOG.info("Set robot {} online status to false on platform {}: {}",
                            info.getRobotId(), platform,
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
     * @param platform SDK 上报的平台号（null = 默认平台 Linux=7）
     */
    public boolean authenticateSession(String sessionId, String robotId, RobotService robotService, Integer platform) {
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
        info.setPlatform(platform);

        robotSessionMap.computeIfAbsent(robotId, k -> new CopyOnWriteArraySet<>()).add(sessionId);

        // 通知 IMSDK 设置机器人在线（使用 SDK 上报的平台）
        setRobotOnlineAsync(robotService, robotId, true, platform);

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
     * 序列化后统一给 messageId/messageUid 附加 String 字段（messageIdString/
     * messageUidString）：这两个字段是 int64，超过 JS Number 安全整数（2^53），
     * JS 端 JSON.parse 会精度丢失（571912188042674306 → ...300），导致按 uid 定位
     * 失败。原数字字段保持不变（其他平台 SDK 兼容），JS 端优先读 String 字段。
     */
    public boolean sendMessage(WebSocketSession session, Object message) {
        if (session != null && session.isOpen()) {
            try {
                String json = gson.toJson(message);
                json = addUidStringFields(json);
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
     * 递归为 JSON 中所有 messageId/messageUid 数字字段附加
     * messageIdString/messageUidString（字符串原值，JS 端防 int64 精度丢失）。
     * 原数字字段不动，其他平台 SDK 不受影响。
     */
    private static String addUidStringFields(String json) {
        try {
            com.google.gson.JsonObject root = com.google.gson.JsonParser.parseString(json).getAsJsonObject();
            addUidStringsRecursive(root);
            return root.toString();
        } catch (Exception e) {
            // 非 JSON 或解析失败：原样返回
            return json;
        }
    }

    private static void addUidStringsRecursive(com.google.gson.JsonObject obj) {
        // 遍历中不能修改 LinkedTreeMap（会抛 ConcurrentModificationException），
        // 先收集需要附加的键，遍历结束后统一 addProperty。
        java.util.List<java.util.Map.Entry<String, com.google.gson.JsonElement>> toAdd =
                new java.util.ArrayList<>();
        for (java.util.Map.Entry<String, com.google.gson.JsonElement> entry : obj.entrySet()) {
            com.google.gson.JsonElement el = entry.getValue();
            if (el.isJsonObject()) {
                addUidStringsRecursive(el.getAsJsonObject());
            } else if (el.isJsonArray()) {
                for (com.google.gson.JsonElement item : el.getAsJsonArray()) {
                    if (item.isJsonObject()) {
                        addUidStringsRecursive(item.getAsJsonObject());
                    }
                }
            } else if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()
                    && ("messageId".equals(entry.getKey()) || "messageUid".equals(entry.getKey()))) {
                toAdd.add(entry);
            }
        }
        for (java.util.Map.Entry<String, com.google.gson.JsonElement> e : toAdd) {
            obj.addProperty(e.getKey() + "String", e.getValue().getAsString());
        }
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
        /** SDK 上报的平台号（null = 默认平台 Linux=7） */
        private Integer platform;
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
        public Integer getPlatform() { return platform; }
        public void setPlatform(Integer platform) { this.platform = platform; }
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
     * @param platform SDK 上报的平台号（null = 默认平台 Linux=7）
     */
    private void setRobotOnlineAsync(RobotService robotService, String robotId, boolean online, Integer platform) {
        if (robotService == null || asyncExecutor == null) {
            return;
        }
        int p = effectivePlatform(platform);
        asyncExecutor.execute(() -> {
            try {
                IMResult<Void> result = robotService.setOnline(p, online);
                LOG.info("Set robot {} online status to {} on platform {}: {}",
                        robotId, online, p,
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
            setRobotOnlineAsync(info.getRobotService(), info.getRobotId(), online, info.getPlatform());
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
