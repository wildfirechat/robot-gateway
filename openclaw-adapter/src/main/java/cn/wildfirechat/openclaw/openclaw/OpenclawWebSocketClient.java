package cn.wildfirechat.openclaw.openclaw;

import cn.wildfirechat.openclaw.config.OpenclawConfig;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawInMessage;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenclawOutMessage;
import cn.wildfirechat.openclaw.openclaw.protocol.OpenClawProtocol;
import cn.wildfirechat.openclaw.session.SessionContextManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Openclaw Gateway WebSocket客户端
 * 负责与Openclaw Gateway的WebSocket通信
 */
public class OpenclawWebSocketClient extends WebSocketClient {
    private static final Logger LOG = LoggerFactory.getLogger(OpenclawWebSocketClient.class);
    private static final long MESSAGE_CONTEXT_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟超时

    private final Gson gson = new Gson();
    private final OpenclawConfig config;
    private final OpenclawMessageHandler messageHandler;
    private final ScheduledExecutorService heartbeatExecutor;
    private final SessionContextManager sessionContextManager;

    private volatile boolean isAuthenticated = false;
    private volatile long lastHeartbeatTime;
    private final ConcurrentHashMap<String, PendingRequest> pendingRequests = new ConcurrentHashMap<>();

    // 保存runId到原始消息context的映射
    private final static ConcurrentHashMap<String, MessageContext> messageContexts = new ConcurrentHashMap<>();

    /**
     * 消息上下文（用于关联AI响应和原始消息）
     */
    private static class MessageContext {
        String senderId;
        String threadId;
        boolean isGroup;
        long timestamp;

        MessageContext(String senderId, String threadId, boolean isGroup) {
            this.senderId = senderId;
            this.threadId = threadId;
            this.isGroup = isGroup;
            this.timestamp = System.currentTimeMillis();
        }
    }

    public OpenclawWebSocketClient(OpenclawConfig config, OpenclawMessageHandler messageHandler) {
        this(config, messageHandler, null);
    }

    public OpenclawWebSocketClient(OpenclawConfig config, OpenclawMessageHandler messageHandler, SessionContextManager sessionContextManager) {
        super(URI.create(config.getUrl())); // 不再需要在URL中添加token
        this.config = config;
        this.messageHandler = messageHandler;
        this.sessionContextManager = sessionContextManager;
        this.heartbeatExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "OpenclawHeartbeatThread");
            thread.setDaemon(true);
            return thread;
        });
        this.setConnectionLostTimeout(30); // 30秒无数据视为连接丢失

        LOG.info("Openclaw WebSocket URI: {}", getURI());
    }

    /**
     * 待处理的请求
     */
    private static class PendingRequest {
        String method;
        String senderId;   // 原始发送者ID
        String threadId;   // 会话ID（群组ID或用户ID）
        boolean isGroup;   // 是否群聊
        long timestamp;

        PendingRequest(String method) {
            this.method = method;
            this.timestamp = System.currentTimeMillis();
        }
    }

    @Override
    public void onOpen(ServerHandshake handshakedata) {
        LOG.info("Connected to Openclaw Gateway: {}", config.getUrl());

        // 不再主动发送connect消息，等待gateway发送connect.challenge事件
        LOG.info("Waiting for connect.challenge event...");
    }

    @Override
    public void onMessage(String message) {
        LOG.debug("Received message from Openclaw: {}", message);

        try {
            // 先尝试解析为通用JSON，获取type字段
            com.google.gson.JsonObject jsonMsg = gson.fromJson(message, com.google.gson.JsonObject.class);
            String msgType = jsonMsg.has("type") ? jsonMsg.get("type").getAsString() : "";

            if ("event".equals(msgType)) {
                // 事件消息（如connect.challenge）
                handleEvent(message, jsonMsg);
            } else if ("res".equals(msgType)) {
                // 响应消息
                handleResponse(message, jsonMsg);
            } else {
                // 其他类型（可能是AI响应等）
                OpenclawInMessage msg = gson.fromJson(message, OpenclawInMessage.class);
                handleOpenclawMessage(msg);
            }

        } catch (Exception e) {
            LOG.error("Failed to parse message from Openclaw: {}", message, e);
        }
    }

    /**
     * 处理响应消息
     */
    private void handleResponse(String messageStr, com.google.gson.JsonObject jsonMsg) {
        String requestId = jsonMsg.has("id") ? jsonMsg.get("id").getAsString() : "";
        boolean ok = jsonMsg.has("ok") && jsonMsg.get("ok").getAsBoolean();

        LOG.debug("Received response for request {}: ok={}", requestId, ok);

        PendingRequest pendingRequest = pendingRequests.get(requestId);
        if (pendingRequest == null) {
            return;
        }

        if ("connect".equals(pendingRequest.method)) {
            pendingRequests.remove(requestId);

            if (ok) {
                isAuthenticated = true;
                LOG.info("Openclaw Gateway connection authenticated successfully");
                if (messageHandler != null) {
                    messageHandler.onConnected();
                }
                // 启动心跳
                startHeartbeat();
            } else {
                LOG.error("Connect request failed: {}", messageStr);
                if (messageHandler != null) {
                    messageHandler.onError("Connect request failed");
                }
            }
        } else if ("chat.send".equals(pendingRequest.method)) {
            pendingRequests.remove(requestId);

            if (!ok) {
                LOG.error("Chat send failed: {}", messageStr);
                if (messageHandler != null) {
                    messageHandler.onError("Chat send failed");
                }
                return;
            }

            // 从响应中提取runId并保存上下文
            if (jsonMsg.has("payload")) {
                com.google.gson.JsonObject payload = jsonMsg.getAsJsonObject("payload");
                if (payload.has("runId")) {
                    String runId = payload.get("runId").getAsString();
                    // 保存runId到sender信息的映射
                    messageContexts.put(runId, new MessageContext(
                        pendingRequest.senderId,
                        pendingRequest.threadId,
                        pendingRequest.isGroup
                    ));
                    
                    // 同时注册到 session 上下文管理器（用于 cron 任务等异步消息）
                    if (sessionContextManager != null && pendingRequest.senderId != null) {
                        sessionContextManager.associateRunId(runId, SessionContextManager.DEFAULT_SESSION_KEY);
                        sessionContextManager.registerSession(
                            SessionContextManager.DEFAULT_SESSION_KEY,
                            pendingRequest.senderId,
                            pendingRequest.threadId,
                            pendingRequest.isGroup
                        );
                    }
                    
                    LOG.debug("Saved message context for runId={}, sender={}", runId, pendingRequest.senderId);
                }
            }
            // chat.send成功后，AI响应会通过event发送
        }
    }

    /**
     * 处理Openclaw消息（AI响应等）
     */
    private void handleOpenclawMessage(OpenclawInMessage msg) {
        if (msg.getType() == null) {
            LOG.warn("Received message without type");
            return;
        }

        switch (msg.getType()) {
            case "response":
                // AI响应
                if (messageHandler != null) {
                    messageHandler.onResponse(msg);
                }
                break;
            case "typing":
                // AI正在输入
                if (messageHandler != null) {
                    messageHandler.onTyping(msg);
                }
                break;
            case "error":
                // 错误消息
                LOG.error("Openclaw Gateway error: {}", msg.getError());
                if (messageHandler != null) {
                    messageHandler.onError(msg.getError());
                }
                break;
            default:
                LOG.warn("Unknown message type from Openclaw: {}", msg.getType());
                break;
        }
    }

    @Override
    public void onClose(int code, String reason, boolean remote) {
        LOG.warn("Openclaw Gateway connection closed: code={}, reason={}, remote={}",
                code, reason, remote);
        isAuthenticated = false;
        stopHeartbeat();

        if (messageHandler != null) {
            messageHandler.onDisconnected(code, reason);
        }
    }

    @Override
    public void onError(Exception ex) {
        LOG.error("Openclaw Gateway WebSocket error", ex);
        if (messageHandler != null) {
            messageHandler.onError(ex.getMessage());
        }
    }

    /**
     * 处理事件消息
     */
    private void handleEvent(String messageStr, com.google.gson.JsonObject jsonMsg) {
        String eventType = jsonMsg.has("event") ? jsonMsg.get("event").getAsString() : "";

        if (eventType == null || eventType.isEmpty()) {
            LOG.warn("Event message without event type");
            return;
        }

        switch (eventType) {
            case "connect.challenge":
                handleChallenge();
                break;
            case "agent":
                handleAgentEvent(jsonMsg);
                break;
            case "chat":
                handleChatEvent(jsonMsg);
                break;
            case "health":
            case "tick":
                // 系统事件，忽略
                break;
            default:
                LOG.debug("Unhandled event type: {}", eventType);
                break;
        }
    }

    /**
     * 处理agent事件（流式文本）
     */
    private void handleAgentEvent(com.google.gson.JsonObject jsonMsg) {
        if (!jsonMsg.has("payload")) {
            return;
        }

        com.google.gson.JsonObject payload = jsonMsg.getAsJsonObject("payload");

        // 提取runId
        String runId = payload.has("runId") ? payload.get("runId").getAsString() : "";

        // 提取stream类型
        String stream = payload.has("stream") ? payload.get("stream").getAsString() : "";

        boolean startCommand = false;
        if("lifecycle".equals(stream) && payload.has("data")) {
            JsonObject data = payload.getAsJsonObject("data");
            if(data.has("phase")) {
                String phase = data.get("phase").getAsString();
                if("start".equals(phase)) {
                    startCommand = true;
                }
            }
        }

        // 只处理assistant流
        if (!"assistant".equals(stream) && !startCommand) {
            return;
        }

        // 提取data中的文本
        if (!payload.has("data") && !startCommand) {
            return;
        }

        com.google.gson.JsonObject data = payload.getAsJsonObject("data");
        if (!data.has("text") && !startCommand) {
            return;
        }

        String text = data.has("text")?data.get("text").getAsString():"";

        // 查找消息上下文（优先从 runId 映射，其次从 session 上下文管理器）
        MessageContext context = messageContexts.get(runId);
        
        // 如果没有找到上下文，尝试从 session 上下文管理器获取（用于 cron 任务等异步消息）
        if (context == null && sessionContextManager != null) {
            SessionContextManager.SessionContext sessionContext = sessionContextManager.getContextByRunId(runId);
            if (sessionContext == null) {
                // 尝试获取默认 session 上下文
                sessionContext = sessionContextManager.getDefaultSessionContext();
            }
            
            if (sessionContext != null) {
                context = new MessageContext(
                    sessionContext.getSenderId(),
                    sessionContext.getThreadId(),
                    sessionContext.isGroup()
                );
                LOG.debug("Resolved context from session manager for runId={}, sender={}", 
                    runId, sessionContext.getSenderId());
            }
        }
        
        if (context == null) {
            LOG.debug("No context found for runId={}, skipping agent event", runId);
            // 清理可能存在的孤立pendingRequests
            pendingRequests.entrySet().removeIf(entry -> {
                if ("chat.send".equals(entry.getValue().method) &&
                    entry.getValue().threadId != null &&
                    entry.getValue().threadId.equals(runId)) {
                    LOG.debug("Removing orphaned pending request for runId={}", runId);
                    return true;
                }
                return false;
            });
            return;
        }

        LOG.debug("Agent event: runId={}, text={}, sender={}", runId,
                text.substring(0, Math.min(50, text.length())), context.senderId);

        // 转换为OpenclawInMessage格式（流式中间状态）
        OpenclawInMessage openclawResponse = new OpenclawInMessage();
        openclawResponse.setType("streaming");  // 使用streaming类型标识流式消息

        OpenclawInMessage.Message msgContent = new OpenclawInMessage.Message();
        msgContent.setText(text);
        // 附加streamId到消息
        msgContent.setExtra("streamId", runId);  // 使用runId作为streamId
        if(startCommand) {
            msgContent.setExtra("state", "start");
        } else {
            msgContent.setExtra("state", "generating");  // 标识为生成中状态
        }
        openclawResponse.setMessage(msgContent);

        // 设置channel信息
        OpenclawInMessage.Channel channel = new OpenclawInMessage.Channel();
        channel.setPeerId(context.senderId);
        channel.setThreadId(context.threadId);
        openclawResponse.setChannel(channel);

        if (messageHandler != null) {
            messageHandler.onResponse(openclawResponse);
        }
    }

    /**
     * 处理chat事件（AI响应）
     */
    private void handleChatEvent(com.google.gson.JsonObject jsonMsg) {
        if (!jsonMsg.has("payload")) {
            return;
        }

        com.google.gson.JsonObject payload = jsonMsg.getAsJsonObject("payload");

        // 提取runId
        String runId = payload.has("runId") ? payload.get("runId").getAsString() : "";

        // 提取消息状态
        String state = payload.has("state") ? payload.get("state").getAsString() : "";

        // 提取消息内容
        String messageText = null;
        if (payload.has("message")) {
            com.google.gson.JsonElement messageElem = payload.get("message");
            if (messageElem.isJsonObject()) {
                com.google.gson.JsonObject messageObj = messageElem.getAsJsonObject();
                // 解析content数组
                if (messageObj.has("content") && messageObj.get("content").isJsonArray()) {
                    com.google.gson.JsonArray contentArray = messageObj.getAsJsonArray("content");
                    if (contentArray.size() > 0) {
                        com.google.gson.JsonElement firstContent = contentArray.get(0);
                        if (firstContent.isJsonObject()) {
                            com.google.gson.JsonObject contentObj = firstContent.getAsJsonObject();
                            if (contentObj.has("text")) {
                                messageText = contentObj.get("text").getAsString();
                            }
                        }
                    }
                }
            } else if (messageElem.isJsonPrimitive()) {
                messageText = messageElem.getAsString();
            }
        }

        LOG.debug("Chat event: state={}, runId={}, text={}", state, runId,
                messageText != null ? messageText.substring(0, Math.min(50, messageText.length())) : "null");

        // 查找消息上下文（优先从 runId 映射，其次从 session 上下文管理器）
        MessageContext context = messageContexts.get(runId);
        
        // 如果没有找到上下文，尝试从 session 上下文管理器获取（用于 cron 任务等异步消息）
        if (context == null && sessionContextManager != null) {
            SessionContextManager.SessionContext sessionContext = sessionContextManager.getContextByRunId(runId);
            if (sessionContext == null) {
                // 尝试获取默认 session 上下文
                sessionContext = sessionContextManager.getDefaultSessionContext();
            }
            
            if (sessionContext != null) {
                context = new MessageContext(
                    sessionContext.getSenderId(),
                    sessionContext.getThreadId(),
                    sessionContext.isGroup()
                );
                LOG.debug("Resolved context from session manager for runId={}, sender={}", 
                    runId, sessionContext.getSenderId());
            }
        }

        // 根据状态处理
        if ("final".equals(state)) {
            // final状态 - 最终结果
            if (messageText != null && !messageText.isEmpty()) {
                // 转换为OpenclawInMessage格式
                OpenclawInMessage openclawResponse = new OpenclawInMessage();
                openclawResponse.setType("response");

                OpenclawInMessage.Message msgContent = new OpenclawInMessage.Message();
                msgContent.setText(messageText);
                // 附加streamId和状态信息
                msgContent.setExtra("streamId", runId);
                msgContent.setExtra("state", "completed");  // 标识为完成状态
                openclawResponse.setMessage(msgContent);

                // 设置channel信息
                OpenclawInMessage.Channel channel = new OpenclawInMessage.Channel();
                if (context != null) {
                    channel.setPeerId(context.senderId);
                    channel.setThreadId(context.threadId);
                }
                openclawResponse.setChannel(channel);

                if (messageHandler != null) {
                    messageHandler.onResponse(openclawResponse);
                }
            }

            // 清理上下文
            messageContexts.remove(runId);
        } else if ("error".equals(state)) {
            String errorMessage = payload.has("errorMessage") ?
                    payload.get("errorMessage").getAsString() : "Unknown error";
            LOG.error("Chat event error: {}", errorMessage);
            if (messageHandler != null) {
                messageHandler.onError(errorMessage);
            }
            // 清理上下文
            messageContexts.remove(runId);
        }
    }

    /**
     * 处理连接挑战
     */
    private void handleChallenge() {
        LOG.info("Received connect challenge from Openclaw Gateway");

        // 发送OpenClaw协议的connect请求
        sendConnectRequest();
    }

    /**
     * 发送connect请求
     */
    private void sendConnectRequest() {
        String requestId = UUID.randomUUID().toString();

        // 构建connect参数
        OpenClawProtocol.ConnectParams params = new OpenClawProtocol.ConnectParams();
        params.setScopes(new String[]{"operator.read", "operator.write"});

        // 设置client信息
        // id="cli", mode="cli" (从构造函数的默认值)
        OpenClawProtocol.ClientInfo clientInfo = new OpenClawProtocol.ClientInfo();
        // 默认值已经是：
        // - id = "cli"
        // - mode = "cli"
        params.setClient(clientInfo);

        // 设置认证token
        if (config.getToken() != null && !config.getToken().trim().isEmpty()) {
            params.setAuth(new OpenClawProtocol.AuthInfo(config.getToken()));
        }

        // 构建请求消息
        OpenClawProtocol.RequestMessage request = new OpenClawProtocol.RequestMessage(requestId, "connect", params);

        try {
            String json = gson.toJson(request);
            send(json);
            LOG.info("Sent connect request to Openclaw Gateway: {}", json);

            // 记录待处理的请求
            pendingRequests.put(requestId, new PendingRequest("connect"));
        } catch (Exception e) {
            LOG.error("Failed to send connect request", e);
        }
    }

    /**
     * 发送消息到Openclaw Gateway (使用OpenClaw chat.send格式)
     */
    public void sendMessage(OpenclawOutMessage message) {
        sendMessage(message, null);
    }

    /**
     * 发送消息到Openclaw Gateway (使用OpenClaw chat.send格式)
     * @param message 消息内容
     * @param senderId 原始发送者ID（用于AI响应时回复）
     */
    public void sendMessage(OpenclawOutMessage message, String senderId) {
        if (!isAuthenticated) {
            LOG.warn("Not authenticated, cannot send message");
            return;
        }

        try {
            // 注册 session 上下文（用于 cron 任务等异步消息的回复）
            if (sessionContextManager != null && senderId != null) {
                String threadId = message.getChannel() != null ? message.getChannel().getThreadId() : senderId;
                boolean isGroup = message.getChannel() != null && message.getChannel().isGroup();
                sessionContextManager.registerSession(
                    SessionContextManager.DEFAULT_SESSION_KEY,
                    senderId,
                    threadId,
                    isGroup
                );
            }

            // 将OpenclawOutMessage转换为OpenClaw的chat.send格式
            String requestId = UUID.randomUUID().toString();

            // 构建chat.send参数
            OpenClawProtocol.ChatSendParams chatParams = new OpenClawProtocol.ChatSendParams();
            chatParams.setSessionKey("main");  // 使用默认的main session
            chatParams.setMessage(message.getMessage().getText());
            chatParams.setIdempotencyKey(UUID.randomUUID().toString());
            
            // 添加附件（如果有媒体）
            if (message.getMessage() != null && message.getMessage().getMediaUrl() != null && !message.getMessage().getMediaUrl().isEmpty()) {
                OpenClawProtocol.Attachment attachment = new OpenClawProtocol.Attachment();
                attachment.setType(message.getMessage().getMediaType());
                attachment.setUrl(message.getMessage().getMediaUrl());
                chatParams.setAttachments(java.util.Collections.singletonList(attachment));
                LOG.debug("Adding attachment to message: type={}, url={}", attachment.getType(), attachment.getUrl());
            }

            // 构建req消息
            OpenClawProtocol.RequestMessage request = new OpenClawProtocol.RequestMessage();
            request.setId(requestId);
            request.setMethod("chat.send");
            request.setParams(chatParams);

            String json = gson.toJson(request);
            send(json);
            LOG.info("Sent chat.send request to Openclaw Gateway: text={}, sender={}",
                    message.getMessage().getText() != null ?
                    message.getMessage().getText().substring(0, Math.min(50, message.getMessage().getText().length())) : "null",
                    senderId);

            // 记录待处理的请求，同时保存sender信息
            PendingRequest pendingReq = new PendingRequest("chat.send");
            pendingReq.senderId = senderId;
            pendingReq.threadId = message.getChannel().getThreadId();
            pendingReq.isGroup = message.getChannel().isGroup();
            pendingRequests.put(requestId, pendingReq);

        } catch (Exception e) {
            LOG.error("Failed to send message to Openclaw", e);
        }
    }

    /**
     * 启动心跳
     */
    private void startHeartbeat() {
        lastHeartbeatTime = System.currentTimeMillis();

        heartbeatExecutor.scheduleAtFixedRate(() -> {
            try {
                if (isOpen() && isAuthenticated) {
                    // 发送ping
                    sendPing();
                    lastHeartbeatTime = System.currentTimeMillis();
                    LOG.debug("Sent ping to Openclaw Gateway");
                }
                // 清理超时的消息上下文
                cleanupExpiredMessageContexts();
                // 清理过期的session上下文
                if (sessionContextManager != null) {
                    sessionContextManager.cleanupExpiredSessions(MESSAGE_CONTEXT_TIMEOUT_MS);
                }
            } catch (Exception e) {
                LOG.error("Heartbeat error", e);
            }
        }, config.getHeartbeatInterval(), config.getHeartbeatInterval(), TimeUnit.MILLISECONDS);

        LOG.info("Openclaw heartbeat started with interval: {} ms", config.getHeartbeatInterval());
    }

    /**
     * 清理超时的消息上下文，防止内存泄漏
     */
    private void cleanupExpiredMessageContexts() {
        long now = System.currentTimeMillis();
        int removedCount = 0;
        for (java.util.Map.Entry<String, MessageContext> entry : messageContexts.entrySet()) {
            if (now - entry.getValue().timestamp > MESSAGE_CONTEXT_TIMEOUT_MS) {
                messageContexts.remove(entry.getKey());
                removedCount++;
            }
        }
        if (removedCount > 0) {
            LOG.debug("Cleaned up {} expired message contexts", removedCount);
        }
    }

    /**
     * 停止心跳
     */
    private void stopHeartbeat() {
        if (heartbeatExecutor != null && !heartbeatExecutor.isShutdown()) {
            heartbeatExecutor.shutdown();
            try {
                if (!heartbeatExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    heartbeatExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                heartbeatExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            LOG.info("Openclaw heartbeat stopped");
        }
    }

    /**
     * 检查是否已认证
     */
    public boolean isAuthenticated() {
        return isAuthenticated && isOpen();
    }

    /**
     * 获取最后一次心跳时间
     */
    public long getLastHeartbeatTime() {
        return lastHeartbeatTime;
    }

    /**
     * 关闭连接
     */
    public void closeConnection() {
        stopHeartbeat();
        close();
    }

    /**
     * Openclaw消息处理器接口
     */
    public interface OpenclawMessageHandler {
        /**
         * 连接成功
         */
        void onConnected();

        /**
         * 连接断开
         */
        void onDisconnected(int code, String reason);

        /**
         * 收到AI响应
         */
        void onResponse(OpenclawInMessage response);

        /**
         * AI正在输入
         */
        void onTyping(OpenclawInMessage typing);

        /**
         * 错误
         */
        void onError(String error);
    }
}
