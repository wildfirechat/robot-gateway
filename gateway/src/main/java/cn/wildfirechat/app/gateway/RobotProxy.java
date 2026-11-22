package cn.wildfirechat.app.gateway;

import cn.wildfirechat.app.protocol.ResponseMessage;
import cn.wildfirechat.common.ErrorCode;
import cn.wildfirechat.pojos.OutputCreateGroupResult;
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
import java.util.Map;

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
        String requestId = request.getRequestId();

        LOG.info("Handling request from session {}: method={}, requestId={}", sessionId, method, requestId);

        // 检查鉴权状态
        if (!sessionManager.isAuthenticated(sessionId)) {
            return ResponseMessage.error(requestId, 401, "Not authenticated");
        }

        // 获取会话对应的RobotService实例
        RobotService robotService = sessionManager.getRobotService(sessionId);
        if (robotService == null) {
            return ResponseMessage.error(requestId, 500, "Robot service not found");
        }

        if("setCallback".equals(method) || "getCallback".equals(method) || "deleteCallback".equals(method)) {
            return ResponseMessage.error(requestId, 400, "Bad Request(" + method + ")");
        }

        try {
            // createGroup/addGroupMembers 的 members 必须是对象数组；
            // 直接传字符串 ID 时 IM 服务会返回 code=0/result=null，等于静默失败。
            if (("createGroup".equals(method) || "addGroupMembers".equals(method))
                    && params != null && params.size() > 1) {
                String error = validateGroupMembers(method, params.get(1));
                if (error != null) return ResponseMessage.error(requestId, 400, error);
            }
            if (("setGroupManager".equals(method) || "muteGroupMember".equals(method)
                    || "allowGroupMember".equals(method) || "kickoffGroupMembers".equals(method))
                    && params != null && params.size() > 1) {
                String error = validateStringMemberIds(method, params.get(1));
                if (error != null) return ResponseMessage.error(requestId, 400, error);
            }
            if (("getMessage".equals(method) || "replyMessage".equals(method)
                    || "recallMessage".equals(method) || "updateMessage".equals(method))
                    && params != null && !params.isEmpty()) {
                String error = validateMessageId(method, params.get(0));
                if (error != null) return ResponseMessage.error(requestId, 400, error);
            }

            // 查找方法
            Method targetMethod = findMethod(robotService.getClass(), method, params);
            if (targetMethod == null) {
                return ResponseMessage.error(requestId, 404, "Method not found: " + method);
            }

            // 转换参数类型并调用方法
            Object[] args = convertParams(targetMethod, params);
            Object result = targetMethod.invoke(robotService, args);

            // 对“必须产生实体”的方法，拒绝 code=0 但 result 为空。
            if ("createGroup".equals(method) && result instanceof IMResult) {
                IMResult<?> imResult = (IMResult<?>) result;
                if (imResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS) {
                    Object created = imResult.getResult();
                    String groupId = created instanceof OutputCreateGroupResult
                            ? ((OutputCreateGroupResult) created).getGroup_id() : null;
                    if (groupId == null || groupId.trim().isEmpty()) {
                        LOG.warn("createGroup returned success without group_id; requestId={}", requestId);
                        return ResponseMessage.error(requestId, 502,
                                "createGroup returned success but no group_id (check members: [{member_id, type}], to/lines)");
                    }
                }
            }

            if ("getGroupInfo".equals(method) && result instanceof IMResult) {
                IMResult<?> imResult = (IMResult<?>) result;
                if (imResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS && imResult.getResult() == null) {
                    return ResponseMessage.error(requestId, 404, "group not found: " + String.valueOf(params == null || params.isEmpty() ? "" : params.get(0)));
                }
            }

            if("getProfile".equals(method) && result instanceof IMResult) {
                IMResult<OutputRobot> imResult = (IMResult<OutputRobot>)result;
                if(imResult.getErrorCode() == ErrorCode.ERROR_CODE_SUCCESS && imResult.getResult() != null) {
                    imResult.getResult().setCallback(null);
                    imResult.getResult().setSecret(null);
                }
            }
            // 返回成功结果
            return ResponseMessage.success(requestId, result);

        } catch (IllegalArgumentException e) {
            LOG.error("Invalid arguments for method {}: {}", method, e.getMessage());
            return ResponseMessage.error(requestId, 400, "Invalid arguments: " + e.getMessage());
        } catch (Exception e) {
            LOG.error("Failed to execute method {}: {}", method, e.getMessage(), e);
            return ResponseMessage.error(requestId, 500, "Failed to execute: " + e.getMessage());
        }
    }

    /** Manager/mute/allow/kick APIs use bare user-id strings, unlike createGroup. */
    private String validateStringMemberIds(String method, Object rawMembers) {
        if (!(rawMembers instanceof List)) {
            return method + ": members must be an array of user-id strings";
        }
        List<?> members = (List<?>) rawMembers;
        if (members.isEmpty()) return method + ": members must not be empty";
        for (int i = 0; i < members.size(); i++) {
            Object item = members.get(i);
            if (!(item instanceof String) || ((String) item).trim().isEmpty()) {
                return method + ": members[" + i + "] must be a user-id string (not a { member_id } object)";
            }
        }
        return null;
    }

    /** Message id/UID params are long values; JS must send them as numeric strings. */
    private String validateMessageId(String method, Object rawMessageId) {
        if (!(rawMessageId instanceof String) || !((String) rawMessageId).matches("\\d+")) {
            return method + ": messageId/messageUid must be a non-empty numeric string (JS number loses precision)";
        }
        return null;
    }

    /**
     * Validate the raw JSON members argument before reflection converts it.
     * Accepts only object entries with a non-empty member_id.
     */
    private String validateGroupMembers(String method, Object rawMembers) {
        if (!(rawMembers instanceof List)) {
            return method + ": members must be an array of { member_id, type? } objects";
        }
        List<?> members = (List<?>) rawMembers;
        if (members.isEmpty()) return method + ": members must not be empty";
        for (int i = 0; i < members.size(); i++) {
            Object item = members.get(i);
            if (!(item instanceof Map)) {
                return method + ": members[" + i + "] must be an object with member_id (bare string ids are invalid)";
            }
            Object memberId = ((Map<?, ?>) item).get("member_id");
            if (!(memberId instanceof String) || ((String) memberId).trim().isEmpty()) {
                return method + ": members[" + i + "].member_id is required";
            }
        }
        return null;
    }

    /**
     * 查找匹配的方法
     * 通过参数数量和参数类型进行匹配
     */
    private Method findMethod(Class<?> clazz, String methodName, List<Object> params) {
        int paramCount = (params != null) ? params.size() : 0;
        Method bestMatch = null;
        int bestMatchScore = -1;

        for (Method method : clazz.getMethods()) {
            if (!method.getName().equals(methodName)) {
                continue;
            }

            Class<?>[] paramTypes = method.getParameterTypes();

            // 检查参数数量
            if (paramTypes.length != paramCount) {
                continue;
            }

            // 计算匹配分数（类型兼容的参数数量）
            int score = 0;
            boolean allCompatible = true;
            for (int i = 0; i < paramCount; i++) {
                Object param = params.get(i);
                if (param == null) {
                    // null 可以匹配任何非基本类型
                    if (!paramTypes[i].isPrimitive()) {
                        score++;
                    }
                } else if (isCompatibleType(param.getClass(), paramTypes[i])) {
                    score++;
                } else {
                    // 类型不兼容，但可能通过 Gson 转换
                    allCompatible = false;
                }
            }

            // 完全类型匹配的优先
            if (allCompatible && score == paramCount) {
                return method;
            }

            // 记录最佳匹配
            if (score > bestMatchScore) {
                bestMatchScore = score;
                bestMatch = method;
            }
        }

        return bestMatch;
    }

    /**
     * 检查类型是否兼容
     */
    private boolean isCompatibleType(Class<?> sourceType, Class<?> targetType) {
        if (targetType.isAssignableFrom(sourceType)) {
            return true;
        }
        // 处理基本类型和包装类型
        if (targetType.isPrimitive()) {
            if (targetType == int.class && (sourceType == Integer.class || sourceType == Long.class || sourceType == Short.class)) return true;
            if (targetType == long.class && (sourceType == Long.class || sourceType == Integer.class || sourceType == Short.class)) return true;
            if (targetType == double.class && (sourceType == Double.class || sourceType == Float.class || sourceType == Integer.class || sourceType == Long.class)) return true;
            if (targetType == float.class && (sourceType == Float.class || sourceType == Double.class || sourceType == Integer.class || sourceType == Long.class)) return true;
            if (targetType == boolean.class && sourceType == Boolean.class) return true;
            if (targetType == short.class && (sourceType == Short.class || sourceType == Integer.class || sourceType == Long.class)) return true;
            if (targetType == byte.class && (sourceType == Byte.class || sourceType == Integer.class)) return true;
        }
        // 包装类型和基本类型互转
        if (sourceType == Integer.class && targetType == int.class) return true;
        if (sourceType == Long.class && targetType == long.class) return true;
        if (sourceType == Double.class && targetType == double.class) return true;
        if (sourceType == Float.class && targetType == float.class) return true;
        if (sourceType == Boolean.class && targetType == boolean.class) return true;
        if (sourceType == Short.class && targetType == short.class) return true;
        if (sourceType == Byte.class && targetType == byte.class) return true;

        return false;
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
                // 基本类型需要默认值
                if (paramTypes[i] == int.class) args[i] = 0;
                else if (paramTypes[i] == long.class) args[i] = 0L;
                else if (paramTypes[i] == double.class) args[i] = 0.0;
                else if (paramTypes[i] == float.class) args[i] = 0.0f;
                else if (paramTypes[i] == boolean.class) args[i] = false;
                else if (paramTypes[i] == short.class) args[i] = (short) 0;
                else if (paramTypes[i] == byte.class) args[i] = (byte) 0;
                else if (paramTypes[i] == char.class) args[i] = '\u0000';
                else args[i] = null;
            } else if (isCompatibleType(param.getClass(), paramTypes[i])) {
                // 类型兼容，直接使用
                args[i] = param;
            } else {
                // 将参数转换为JSON字符串，再转换为目标类型
                String json = gson.toJson(param);
                args[i] = gson.fromJson(json, paramTypes[i]);
            }
        }

        return args;
    }
}
