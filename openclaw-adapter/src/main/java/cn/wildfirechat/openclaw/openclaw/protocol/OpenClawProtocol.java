package cn.wildfirechat.openclaw.openclaw.protocol;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * OpenClaw Gateway 协议消息类
 */
public class OpenClawProtocol {

    /**
     * 客户端信息
     */
    public static class ClientInfo {
        private String id = "cli";  // 标准客户端ID
        private String version = "1.0.0";
        private String platform = "java";
        private String mode = "cli";  // 客户端模式，不是role！

        public ClientInfo() {
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getVersion() {
            return version;
        }

        public void setVersion(String version) {
            this.version = version;
        }

        public String getPlatform() {
            return platform;
        }

        public void setPlatform(String platform) {
            this.platform = platform;
        }

        public String getMode() {
            return mode;
        }

        public void setMode(String mode) {
            this.mode = mode;
        }
    }

    /**
     * 认证信息
     */
    public static class AuthInfo {
        private String token;

        public AuthInfo() {
        }

        public AuthInfo(String token) {
            this.token = token;
        }

        public String getToken() {
            return token;
        }

        public void setToken(String token) {
            this.token = token;
        }
    }

    /**
     * Connect请求参数
     */
    public static class ConnectParams {
        private int minProtocol = 3;
        private int maxProtocol = 3;
        private ClientInfo client;
        private String role = "operator";
        private String[] scopes = new String[]{"operator.read", "operator.write"};
        private AuthInfo auth;
        private String userAgent = "openclaw-adapter/1.0.0";

        public ConnectParams() {
            client = new ClientInfo();
        }

        public int getMinProtocol() {
            return minProtocol;
        }

        public void setMinProtocol(int minProtocol) {
            this.minProtocol = minProtocol;
        }

        public int getMaxProtocol() {
            return maxProtocol;
        }

        public void setMaxProtocol(int maxProtocol) {
            this.maxProtocol = maxProtocol;
        }

        public ClientInfo getClient() {
            return client;
        }

        public void setClient(ClientInfo client) {
            this.client = client;
        }

        public String getRole() {
            return role;
        }

        public void setRole(String role) {
            this.role = role;
        }

        public String[] getScopes() {
            return scopes;
        }

        public void setScopes(String[] scopes) {
            this.scopes = scopes;
        }

        public AuthInfo getAuth() {
            return auth;
        }

        public void setAuth(AuthInfo auth) {
            this.auth = auth;
        }

        public String getUserAgent() {
            return userAgent;
        }

        public void setUserAgent(String userAgent) {
            this.userAgent = userAgent;
        }
    }

    /**
     * 请求消息（通用）
     */
    public static class RequestMessage {
        private String type = "req";
        private String id;
        private String method;
        private Object params;  // 使用Object类型，可以是ConnectParams或ChatSendParams

        public RequestMessage() {
        }

        public RequestMessage(String requestId, String method, Object params) {
            this.id = requestId;
            this.method = method;
            this.params = params;
        }

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getMethod() {
            return method;
        }

        public void setMethod(String method) {
            this.method = method;
        }

        public Object getParams() {
            return params;
        }

        public void setParams(Object params) {
            this.params = params;
        }
    }

    /**
     * ChatSend参数
     */
    public static class ChatSendParams {
        private String sessionKey;  // 会话键，如"main"
        private String message;      // 消息文本
        private String idempotencyKey;  // 幂等键，用于防止重复

        public ChatSendParams() {
        }

        public ChatSendParams(String sessionKey, String message, String idempotencyKey) {
            this.sessionKey = sessionKey;
            this.message = message;
            this.idempotencyKey = idempotencyKey;
        }

        public String getSessionKey() {
            return sessionKey;
        }

        public void setSessionKey(String sessionKey) {
            this.sessionKey = sessionKey;
        }

        public String getMessage() {
            return message;
        }

        public void setMessage(String message) {
            this.message = message;
        }

        public String getIdempotencyKey() {
            return idempotencyKey;
        }

        public void setIdempotencyKey(String idempotencyKey) {
            this.idempotencyKey = idempotencyKey;
        }
    }

    /**
     * 响应消息
     */
    public static class ResponseMessage {
        private String type;
        private String id;
        private Boolean ok;
        private ResponsePayload payload;
        private Object error;

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public Boolean getOk() {
            return ok;
        }

        public void setOk(Boolean ok) {
            this.ok = ok;
        }

        public ResponsePayload getPayload() {
            return payload;
        }

        public void setPayload(ResponsePayload payload) {
            this.payload = payload;
        }

        public Object getError() {
            return error;
        }

        public void setError(Object error) {
            this.error = error;
        }
    }

    /**
     * 响应载荷
     */
    public static class ResponsePayload {
        private String type;
        private int protocol;
        private Policy policy;

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        public int getProtocol() {
            return protocol;
        }

        public void setProtocol(int protocol) {
            this.protocol = protocol;
        }

        public Policy getPolicy() {
            return policy;
        }

        public void setPolicy(Policy policy) {
            this.policy = policy;
        }
    }

    /**
     * 策略信息
     */
    public static class Policy {
        private int tickIntervalMs;

        public int getTickIntervalMs() {
            return tickIntervalMs;
        }

        public void setTickIntervalMs(int tickIntervalMs) {
            this.tickIntervalMs = tickIntervalMs;
        }
    }
}
