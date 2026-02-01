package cn.wildfirechat.client;

import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.handler.ResponseHandler;
import cn.wildfirechat.client.protocol.ConnectMessage;
import cn.wildfirechat.client.protocol.PushMessage;
import cn.wildfirechat.client.protocol.RequestMessage;
import cn.wildfirechat.client.protocol.ResponseMessage;
import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * 机器人网关WebSocket客户端
 */
class RobotGatewayClient extends WebSocketClient {
    private static final Logger LOG = LoggerFactory.getLogger(RobotGatewayClient.class);

    private final MessageHandler messageHandler;
    private final ConnectionManager connectionManager;
    private final ResponseHandler responseHandler;
    private final Gson gson = new Gson();

    private CompletableFuture<Boolean> authFuture;

    public RobotGatewayClient(String gatewayUrl, MessageHandler messageHandler, ConnectionManager connectionManager) {
        super(URI.create(gatewayUrl));
        this.messageHandler = messageHandler;
        this.connectionManager = connectionManager;
        this.responseHandler = new ResponseHandler();
    }

    @Override
    public void onOpen(ServerHandshake handshakedata) {
        LOG.info("WebSocket connection opened");
        if (connectionManager != null) {
            connectionManager.onConnected();
        }
    }

    @Override
    public void onMessage(String message) {
        LOG.debug("Received message: {}", message);

        // 尝试解析为鉴权响应
        try {
            ConnectMessage connectMsg = gson.fromJson(message, ConnectMessage.class);
            if ("connect".equals(connectMsg.getType()) && connectMsg.getCode() != null) {
                handleConnectResponse(connectMsg);
                return;
            }
        } catch (JsonSyntaxException e) {
            // 不是鉴权消息，继续尝试其他类型
        }

        // 尝试解析为响应消息
        try {
            ResponseMessage response = gson.fromJson(message, ResponseMessage.class);
            if (response.getRequestId() != null) {
                responseHandler.handleResponse(response);
                return;
            }
        } catch (JsonSyntaxException e) {
            // 不是响应消息，继续尝试其他类型
        }

        // 尝试解析为推送消息
        try {
            PushMessage push = gson.fromJson(message, PushMessage.class);
            if ("message".equals(push.getType()) || "event".equals(push.getType())) {
                if (messageHandler != null) {
                    messageHandler.onMessage(push);
                }
                return;
            }
        } catch (JsonSyntaxException e) {
            LOG.error("Failed to parse message: {}", e.getMessage());
        }
    }

    /**
     * 处理鉴权响应
     */
    private void handleConnectResponse(ConnectMessage msg) {
        if (authFuture != null) {
            if (msg.isSuccess()) {
                LOG.info("Authentication successful");
                if (connectionManager != null) {
                    connectionManager.onAuthenticated();
                }
                authFuture.complete(true);
            } else {
                LOG.error("Authentication failed: {}", msg.getMsg());
                // 鉴权失败，通知ConnectionManager清空鉴权信息
                if (connectionManager != null) {
                    connectionManager.onAuthenticationFailed();
                }
                authFuture.complete(false);
            }
            authFuture = null;
        }
    }

    /**
     * 发送鉴权请求
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @param authFuture 鉴权结果Future
     */
    public void sendConnect(String robotId, String secret, CompletableFuture<Boolean> authFuture) {
        this.authFuture = authFuture;
        ConnectMessage request = ConnectMessage.request(robotId, secret);
        String json = gson.toJson(request);

        if (isOpen()) {
            send(json);
            LOG.info("Sent connect request for robot: {}", robotId);
        } else {
            LOG.error("WebSocket is not connected");
            authFuture.complete(false);
        }
    }

    @Override
    public void onClose(int code, String reason, boolean remote) {
        LOG.info("WebSocket connection closed: code={}, reason={}, remote={}", code, reason, remote);
        responseHandler.clear();
        if (authFuture != null) {
            authFuture.complete(false);
            authFuture = null;
        }
        if (connectionManager != null) {
            connectionManager.onDisconnected();
        }
    }

    @Override
    public void onError(Exception ex) {
        LOG.error("WebSocket error: {}", ex.getMessage(), ex);
        if (messageHandler != null) {
            messageHandler.onError(ex.getMessage());
        }
        if (authFuture != null) {
            authFuture.complete(false);
            authFuture = null;
        }
    }

    /**
     * 发送请求并等待响应
     * @param method 方法名
     * @param params 参数列表
     * @return 响应消息Future
     */
    public CompletableFuture<ResponseMessage> sendRequest(String method, java.util.List<Object> params) {
        if (!connectionManager.isAuthenticated()) {
            CompletableFuture<ResponseMessage> future = new CompletableFuture<>();
            future.completeExceptionally(new IllegalStateException("Not authenticated"));
            return future;
        }

        String requestId = UUID.randomUUID().toString();
        RequestMessage request = new RequestMessage(requestId, method, params);

        String json = gson.toJson(request);
        send(json);

        return responseHandler.registerRequest(requestId);
    }
}
