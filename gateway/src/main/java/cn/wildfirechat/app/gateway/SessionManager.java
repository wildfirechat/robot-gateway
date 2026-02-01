package cn.wildfirechat.app.gateway;

import cn.wildfirechat.sdk.RobotService;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import javax.annotation.PostConstruct;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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
     * key: sessionId
     * value: WebSocketSession
     */
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    /**
     * 会话信息
     * key: sessionId
     * value: SessionInfo (包含鉴权状态、机器人ID、RobotService实例)
     */
    private final Map<String, SessionInfo> sessionInfos = new ConcurrentHashMap<>();

    @PostConstruct
    public void init() {
        LOG.info("SessionManager initialized");
    }

    /**
     * 添加会话（未鉴权状态）
     */
    public void addSession(WebSocketSession session) {
        sessions.put(session.getId(), session);
        sessionInfos.put(session.getId(), new SessionInfo(session.getId()));
        LOG.info("Session added: {}, total sessions: {}", session.getId(), sessions.size());
    }

    /**
     * 移除会话
     */
    public void removeSession(WebSocketSession session) {
        String sessionId = session.getId();
        SessionInfo info = sessionInfos.remove(sessionId);
        sessions.remove(sessionId);

        if (info != null && info.getRobotService() != null) {
            // 关闭RobotService实例（如果有close方法）
            try {
                info.getRobotService().close();
            } catch (Exception e) {
                LOG.error("Failed to close robot service: {}", e.getMessage());
            }
        }

        LOG.info("Session removed: {}, total sessions: {}", sessionId, sessions.size());
    }

    /**
     * 鉴权会话
     * @return 鉴权是否成功
     */
    public boolean authenticateSession(String sessionId, String robotId, RobotService robotService) {
        SessionInfo info = sessionInfos.get(sessionId);
        if (info == null) {
            LOG.warn("Session {} not found for authentication", sessionId);
            return false;
        }

        info.setAuthenticated(true);
        info.setRobotId(robotId);
        info.setRobotService(robotService);

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
     * 通过机器人ID获取会话
     */
    public WebSocketSession getSessionByRobotId(String robotId) {
        for (Map.Entry<String, SessionInfo> entry : sessionInfos.entrySet()) {
            if (robotId.equals(entry.getValue().getRobotId())) {
                return sessions.get(entry.getKey());
            }
        }
        return null;
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
                return false;
            }
        }
        return false;
    }

    /**
     * 发送消息到指定会话（通过sessionId）
     */
    public boolean sendMessage(String sessionId, Object message) {
        WebSocketSession session = sessions.get(sessionId);
        if (session != null) {
            return sendMessage(session, message);
        }
        LOG.warn("Session {} not found", sessionId);
        return false;
    }

    /**
     * 发送消息到指定机器人
     */
    public boolean sendMessageToRobot(String robotId, Object message) {
        WebSocketSession session = getSessionByRobotId(robotId);
        if (session != null) {
            return sendMessage(session, message);
        }
        LOG.warn("Robot {} session not found", robotId);
        return false;
    }

    /**
     * 获取当前会话数量
     */
    public int getSessionCount() {
        return sessions.size();
    }

    /**
     * 获取所有会话ID
     */
    public java.util.Set<String> getSessionIds() {
        return sessions.keySet();
    }

    /**
     * 检查会话是否存在
     */
    public boolean hasSession(String sessionId) {
        WebSocketSession session = sessions.get(sessionId);
        return session != null && session.isOpen();
    }

    /**
     * 关闭所有会话
     */
    public void closeAll() {
        for (WebSocketSession session : sessions.values()) {
            try {
                if (session.isOpen()) {
                    session.close();
                }
            } catch (IOException e) {
                LOG.error("Failed to close session {}: {}", session.getId(), e.getMessage());
            }
        }
        // 关闭所有RobotService实例
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
        LOG.info("All sessions closed");
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

        public SessionInfo(String sessionId) {
            this.sessionId = sessionId;
            this.authenticated = false;
            this.lastHeartbeatTime = System.currentTimeMillis();
        }

        public String getSessionId() {
            return sessionId;
        }

        public boolean isAuthenticated() {
            return authenticated;
        }

        public void setAuthenticated(boolean authenticated) {
            this.authenticated = authenticated;
        }

        public String getRobotId() {
            return robotId;
        }

        public void setRobotId(String robotId) {
            this.robotId = robotId;
        }

        public RobotService getRobotService() {
            return robotService;
        }

        public void setRobotService(RobotService robotService) {
            this.robotService = robotService;
        }

        public long getLastHeartbeatTime() {
            return lastHeartbeatTime;
        }

        public void updateHeartbeatTime() {
            this.lastHeartbeatTime = System.currentTimeMillis();
        }
    }

    /**
     * 通过会话ID获取机器人ID
     */
    public String getRobotIdBySession(String sessionId) {
        return getRobotId(sessionId);
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
     * 获取会话的最后心跳时间
     */
    public long getLastHeartbeatTime(String sessionId) {
        SessionInfo info = sessionInfos.get(sessionId);
        return info != null ? info.getLastHeartbeatTime() : 0;
    }
}
