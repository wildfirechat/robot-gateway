package cn.wildfirechat.client.handler;

import cn.wildfirechat.client.protocol.ResponseMessage;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 响应处理器
 * 管理请求-响应的映射关系
 */
public class ResponseHandler {

    private final Map<String, CompletableFuture<ResponseMessage>> pendingRequests = new ConcurrentHashMap<>();
    private final long timeout;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1);

    public ResponseHandler() {
        this(30); // 默认30秒超时
    }

    public ResponseHandler(long timeoutSeconds) {
        this.timeout = timeoutSeconds;
    }

    /**
     * 注册等待响应的请求
     * @param requestId 请求ID
     * @return 响应Future
     */
    public CompletableFuture<ResponseMessage> registerRequest(String requestId) {
        CompletableFuture<ResponseMessage> future = new CompletableFuture<>();
        pendingRequests.put(requestId, future);

        // 设置超时
        scheduler.schedule(() -> {
            CompletableFuture<ResponseMessage> f = pendingRequests.remove(requestId);
            if (f != null && !f.isDone()) {
                f.completeExceptionally(new TimeoutException("Request timeout"));
            }
        }, timeout, TimeUnit.SECONDS);

        return future;
    }

    /**
     * 处理响应
     * @param response 响应消息
     */
    public void handleResponse(ResponseMessage response) {
        String requestId = response.getRequestId();
        if (requestId != null) {
            CompletableFuture<ResponseMessage> future = pendingRequests.remove(requestId);
            if (future != null) {
                future.complete(response);
            }
        }
    }

    /**
     * 移除请求（用于取消）
     * @param requestId 请求ID
     */
    public void removeRequest(String requestId) {
        pendingRequests.remove(requestId);
    }

    /**
     * 清空所有请求
     */
    public void clear() {
        for (CompletableFuture<ResponseMessage> future : pendingRequests.values()) {
            future.completeExceptionally(new TimeoutException("Connection closed"));
        }
        pendingRequests.clear();
    }

    /**
     * 关闭调度器
     */
    public void shutdown() {
        scheduler.shutdown();
    }
}
