package cn.wildfirechat.app.gateway;

import cn.wildfirechat.app.protocol.ConnectMessage;
import cn.wildfirechat.app.protocol.RequestMessage;
import cn.wildfirechat.app.protocol.ResponseMessage;
import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * 机器人网关WebSocket端点
 * 处理客户端的WebSocket连接、鉴权和消息
 */
@Component
public class RobotGatewayEndpoint extends TextWebSocketHandler {

    private static final Logger LOG = LoggerFactory.getLogger(RobotGatewayEndpoint.class);

    @Autowired
    private SessionManager sessionManager;

    @Autowired
    private RobotProxy robotProxy;

    @Autowired
    private AuthHandler authHandler;

    private final Gson gson = new Gson();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        super.afterConnectionEstablished(session);
        sessionManager.addSession(session);
        LOG.info("WebSocket connection established: {}", session.getId());
    }

    @Override
    @Async("asyncExecutor") // 使用异步线程池处理消息
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String payload = message.getPayload();
        String sessionId = session.getId();
        LOG.debug("Received message from {}: {}", sessionId, payload);

        try {
            // 尝试解析为鉴权消息
            ConnectMessage connectMsg = parseConnectMessage(payload);
            if (connectMsg != null) {
                handleConnectMessage(session, connectMsg);
                return;
            }

            // 检查鉴权状态
            if (!sessionManager.isAuthenticated(sessionId)) {
                ConnectMessage error = ConnectMessage.error(401, "Not authenticated. Please send connect message first.");
                sessionManager.sendMessage(session, error);
                session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Not authenticated"));
                return;
            }

            // 解析为普通请求
            RequestMessage request = gson.fromJson(payload, RequestMessage.class);

            // 验证请求格式
            if (request.getRequestId() == null || request.getMethod() == null) {
                ResponseMessage error = ResponseMessage.error(
                        null,
                        400,
                        "Invalid request format: requestId and method are required"
                );
                sessionManager.sendMessage(session, error);
                return;
            }

            // 检查是否为心跳消息
            if ("heartbeat".equals(request.getMethod())) {
                handleHeartbeat(session, request);
                return;
            }

            // 处理请求
            ResponseMessage response = robotProxy.handleRequest(session, request);
            response.setRequestId(request.getRequestId());

            // 发送响应
            sessionManager.sendMessage(session, response);

        } catch (JsonSyntaxException e) {
            LOG.error("Failed to parse message: {}", e.getMessage());
            ConnectMessage error = ConnectMessage.error(400, "Invalid JSON format: " + e.getMessage());
            sessionManager.sendMessage(session, error);
        } catch (Exception e) {
            LOG.error("Failed to handle message: {}", e.getMessage(), e);
            ConnectMessage error = ConnectMessage.error(500, "Internal server error: " + e.getMessage());
            sessionManager.sendMessage(session, error);
        }
    }

    /**
     * 尝试解析为鉴权消息
     */
    private ConnectMessage parseConnectMessage(String payload) {
        try {
            // 检查是否包含type字段且为"connect"
            if (payload.contains("\"type\"") && payload.contains("\"connect\"")) {
                return gson.fromJson(payload, ConnectMessage.class);
            }
        } catch (JsonSyntaxException e) {
            // 不是鉴权消息
        }
        return null;
    }

    /**
     * 处理鉴权消息
     */
    private void handleConnectMessage(WebSocketSession session, ConnectMessage connectMsg) {
        String sessionId = session.getId();
        String robotId = connectMsg.getRobotId();
        String secret = connectMsg.getSecret();

        LOG.info("Authenticating session {} as robot {}", sessionId, robotId);

        // 如果已经鉴权，拒绝重复鉴权
        if (sessionManager.isAuthenticated(sessionId)) {
            ConnectMessage error = ConnectMessage.error(400, "Already authenticated");
            sessionManager.sendMessage(session, error);
            return;
        }

        // 验证凭据
        AuthHandler.AuthResult result = authHandler.authenticateWithResult(robotId, secret);

        if (result.isSuccess()) {
            // 鉴权成功
            sessionManager.authenticateSession(sessionId, robotId, result.getRobotService());
            ConnectMessage success = ConnectMessage.success();
            sessionManager.sendMessage(session, success);
            LOG.info("Session {} authenticated as robot {}", sessionId, robotId);
        } else {
            // 鉴权失败
            ConnectMessage error = ConnectMessage.error(result.getCode(), result.getMsg());
            sessionManager.sendMessage(session, error);
            LOG.warn("Session {} authentication failed: {}", sessionId, result.getMsg());
        }
    }

    /**
     * 处理心跳消息
     */
    private void handleHeartbeat(WebSocketSession session, RequestMessage request) {
        String sessionId = session.getId();
        String robotId = sessionManager.getRobotIdBySession(sessionId);

        // 更新心跳时间
        sessionManager.updateHeartbeatTime(sessionId);

        // 返回心跳响应
        ResponseMessage response = ResponseMessage.success(request.getRequestId(), System.currentTimeMillis());
        sessionManager.sendMessage(session, response);

        LOG.debug("Heartbeat received from robot {}: {}", robotId, sessionId);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        LOG.error("WebSocket transport error for session {}: {}", session.getId(), exception.getMessage());
        sessionManager.removeSession(session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        super.afterConnectionClosed(session, status);
        sessionManager.removeSession(session);
        LOG.info("WebSocket connection closed: {}, status: {}", session.getId(), status);
    }

    @Override
    public boolean supportsPartialMessages() {
        return false; // 不支持部分消息
    }
}
