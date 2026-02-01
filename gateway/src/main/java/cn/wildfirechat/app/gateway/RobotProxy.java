package cn.wildfirechat.app.gateway;

import cn.wildfirechat.app.protocol.ResponseMessage;
import cn.wildfirechat.common.ErrorCode;
import cn.wildfirechat.pojos.OutputRobot;
import cn.wildfirechat.sdk.RobotService;
import cn.wildfirechat.sdk.model.IMResult;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

import java.lang.reflect.Method;
import java.util.List;

/**
 * 机器人服务代理
 * 通过反射调用RobotService SDK的方法，支持多实例
 */
@Component
public class RobotProxy {

    private static final Logger LOG = LoggerFactory.getLogger(RobotProxy.class);

    @Autowired
    private SessionManager sessionManager;

    private final Gson gson = new Gson();

    /**
     * 处理客户端请求
     * @param session WebSocket会话
     * @param request 请求消息
     * @return 响应消息
     */
    public ResponseMessage handleRequest(WebSocketSession session, cn.wildfirechat.app.protocol.RequestMessage request) {
        String sessionId = session.getId();
        String method = request.getMethod();
        List<Object> params = request.getParams();

        LOG.info("Handling request from session {}: method={}", sessionId, method);

        // 检查鉴权状态
        if (!sessionManager.isAuthenticated(sessionId)) {
            return ResponseMessage.error(null, 401, "Not authenticated");
        }

        // 获取会话对应的RobotService实例
        RobotService robotService = sessionManager.getRobotService(sessionId);
        if (robotService == null) {
            return ResponseMessage.error(request.getRequestId(), 500, "Robot service not found");
        }

        if("setCallback".equals(method) || "getCallback".equals(method) || "deleteCallback".equals(method)) {
            return ResponseMessage.error(request.getRequestId(), 400, "Bad Request(" + method + ")");
        }

        try {
            // 查找方法
            Method targetMethod = findMethod(robotService.getClass(), method, params);
            if (targetMethod == null) {
                return ResponseMessage.error(null, 404, "Method not found: " + method);
            }

            // 转换参数类型并调用方法
            Object[] args = convertParams(targetMethod, params);
            Object result = targetMethod.invoke(robotService, args);

            if("getProfile".equals(method) && result instanceof IMResult) {
                IMResult<OutputRobot> imResult = (IMResult<OutputRobot>)result;
                if(imResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS && imResult.getResult() != null) {
                    imResult.getResult().setCallback(null);
                    imResult.getResult().setSecret(null);
                }
            }
            // 返回成功结果
            return ResponseMessage.success(null, result);

        } catch (IllegalArgumentException e) {
            LOG.error("Invalid arguments for method {}: {}", method, e.getMessage());
            return ResponseMessage.error(null, 400, "Invalid arguments: " + e.getMessage());
        } catch (Exception e) {
            LOG.error("Failed to execute method {}: {}", method, e.getMessage(), e);
            return ResponseMessage.error(null, 500, "Failed to execute: " + e.getMessage());
        }
    }

    /**
     * 查找匹配的方法
     */
    private Method findMethod(Class<?> clazz, String methodName, List<Object> params) {
        for (Method method : clazz.getMethods()) {
            if (method.getName().equals(methodName)) {
                // 简单匹配：检查参数数量
                if (method.getParameterCount() == (params != null ? params.size() : 0)) {
                    return method;
                }
            }
        }
        // 尝试查找可变参数的方法
        for (Method method : clazz.getMethods()) {
            if (method.getName().equals(methodName)) {
                return method;
            }
        }
        return null;
    }

    /**
     * 转换参数类型
     * 使用Gson将参数转换为目标方法的参数类型
     */
    private Object[] convertParams(Method method, List<Object> params) {
        Class<?>[] paramTypes = method.getParameterTypes();
        Object[] args = new Object[paramTypes.length];

        for (int i = 0; i < paramTypes.length; i++) {
            Object param = params.get(i);

            if (param == null) {
                args[i] = null;
            } else {
                // 将参数转换为JSON字符串，再转换为目标类型
                String json = gson.toJson(param);
                args[i] = gson.fromJson(json, paramTypes[i]);
            }
        }

        return args;
    }
}
