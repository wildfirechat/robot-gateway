package cn.wildfirechat.client;

import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.ResponseMessage;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.pojos.moments.CommentPojo;
import cn.wildfirechat.pojos.moments.FeedsPojo;
import cn.wildfirechat.pojos.moments.FeedPojo;
import cn.wildfirechat.pojos.moments.MediaEntry;
import cn.wildfirechat.pojos.moments.MomentProfilePojo;
import cn.wildfirechat.sdk.model.IMResult;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import java.lang.reflect.Type;
import java.util.Arrays;
import java.util.List;

/**
 * RobotService客户端实现
 * 通过WebSocket与网关通信，实现RobotService的所有方法
 */
public class RobotServiceClient {
    private static final Logger LOG = LoggerFactory.getLogger(RobotServiceClient.class);
    private static final Gson GSON = new Gson();

    private final ConnectionManager connectionManager;
    private final long defaultTimeout;

    public RobotServiceClient(String gatewayUrl, MessageHandler messageHandler) {
        this(gatewayUrl, messageHandler, 30); // 默认30秒超时
    }

    public RobotServiceClient(String gatewayUrl, MessageHandler messageHandler, long timeoutSeconds) {
        this.connectionManager = new ConnectionManager(gatewayUrl, messageHandler);
        this.defaultTimeout = timeoutSeconds;
    }

    public boolean connect(String robotId, String secret) {
        return connectionManager.connect(robotId, secret);
    }

    public String getRobotId() {
        return connectionManager.getRobotId();
    }

    /**
     * 是否已连接
     * @return 如果已连接返回true，否则返回false
     */
    public boolean isConnected() {
        return connectionManager.isConnected();
    }

    /**
     * 是否已鉴权
     * @return 如果已鉴权返回true，否则返回false
     */
    public boolean isAuthenticated() {
        return connectionManager.isAuthenticated();
    }

    /**
     * 是否正在运行
     * @return 如果正在运行返回true，否则返回false
     */
    public boolean isRunning() {
        return connectionManager.isRunning();
    }
    /**
     * 执行远程调用
     */
    private <T> IMResult<T> invoke(String method, List<Object> params, Type resultType) {
        if (!connectionManager.isConnected()) {
            IMResult<T> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("Not connected to gateway");
            return result;
        }

        try {
            CompletableFuture<ResponseMessage> future = connectionManager.getClient()
                    .sendRequest(method, params);
            ResponseMessage response = future.get(defaultTimeout, TimeUnit.SECONDS);

            if (response.isSuccess()) {
                return GSON.fromJson(GSON.toJson(response.getResult()), resultType);
            } else {
                IMResult<T> result = new IMResult<>();
                result.setCode(response.getCode());
                result.setMsg(response.getMsg());
                return result;
            }
        } catch (TimeoutException e) {
            LOG.error("Request timeout: {}", method);
            IMResult<T> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("Request timeout");
            return result;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            IMResult<T> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("Request interrupted");
            return result;
        } catch (ExecutionException e) {
            LOG.error("Request execution failed: {}", e.getCause().getMessage());
            IMResult<T> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("Request failed: " + e.getCause().getMessage());
            return result;
        } catch (Exception e) {
            LOG.error("Request failed: {}", e.getMessage());
            IMResult<T> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("Request failed: " + e.getMessage());
            return result;
        }
    }

    // ==================== 消息相关 ====================

    public IMResult<SendMessageResult> sendMessage(Conversation conv, MessagePayload payload) {
        return invoke("sendMessage", Arrays.asList(getRobotId(), conv, payload),
                new com.google.gson.reflect.TypeToken<IMResult<SendMessageResult>>(){}.getType());
    }

    public IMResult<SendMessageResult> sendMessage(Conversation conv, MessagePayload payload, List<String> toUsers) {
        return invoke("sendMessage", Arrays.asList(getRobotId(), conv, payload, toUsers),
                new com.google.gson.reflect.TypeToken<IMResult<SendMessageResult>>(){}.getType());
    }

    public IMResult<SendMessageResult> replyMessage(long messageId, MessagePayload payload, boolean mentionSender) {
        return invoke("replyMessage", Arrays.asList(messageId, payload, mentionSender),
                new com.google.gson.reflect.TypeToken<IMResult<SendMessageResult>>(){}.getType());
    }

    public IMResult<String> recallMessage(long messageId) {
        return invoke("recallMessage", Arrays.asList(messageId),
                new com.google.gson.reflect.TypeToken<IMResult<String>>(){}.getType());
    }

    public IMResult<Void> updateMessage(long messageId, MessagePayload payload) {
        return invoke("updateMessage", Arrays.asList(messageId, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    // ==================== 用户相关 ====================

    public IMResult<InputOutputUserInfo> getUserInfo(String userId) {
        return invoke("getUserInfo", Arrays.asList(userId),
                new com.google.gson.reflect.TypeToken<IMResult<InputOutputUserInfo>>(){}.getType());
    }

    public IMResult<InputOutputUserInfo> getUserInfoByMobile(String mobile) {
        return invoke("getUserInfoByMobile", Arrays.asList(mobile),
                new com.google.gson.reflect.TypeToken<IMResult<InputOutputUserInfo>>(){}.getType());
    }

    public IMResult<InputOutputUserInfo> getUserInfoByName(String name) {
        return invoke("getUserInfoByName", Arrays.asList(name),
                new com.google.gson.reflect.TypeToken<IMResult<InputOutputUserInfo>>(){}.getType());
    }

    public IMResult<OutputApplicationUserInfo> applicationGetUserInfo(String userId) {
        return invoke("applicationGetUserInfo", Arrays.asList(userId),
                new com.google.gson.reflect.TypeToken<IMResult<OutputApplicationUserInfo>>(){}.getType());
    }

    // ==================== 机器人资料 ====================

    public IMResult<OutputRobot> getProfile() {
        return invoke("getProfile", null,
                new com.google.gson.reflect.TypeToken<IMResult<OutputRobot>>(){}.getType());
    }

    public IMResult<Void> updateProfile(int type, String value) {
        return invoke("updateProfile", Arrays.asList(type, value),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    // ==================== 群组相关 ====================

    public IMResult<OutputCreateGroupResult> createGroup(PojoGroupInfo groupInfo, List<PojoGroupMember> members, String to, List<Integer> lines, MessagePayload payload) {
        return invoke("createGroup", Arrays.asList(groupInfo, members, to, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<OutputCreateGroupResult>>(){}.getType());
    }

    public IMResult<PojoGroupInfo> getGroupInfo(String groupId) {
        return invoke("getGroupInfo", Arrays.asList(groupId),
                new com.google.gson.reflect.TypeToken<IMResult<PojoGroupInfo>>(){}.getType());
    }

    public IMResult<Void> dismissGroup(String groupId, List<Integer> lines, MessagePayload payload) {
        return invoke("dismissGroup", Arrays.asList(groupId, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> transferGroup(String groupId, String newOwner, List<Integer> lines, MessagePayload payload) {
        return invoke("transferGroup", Arrays.asList(groupId, newOwner, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> modifyGroupInfo(String groupId, int type, String value, List<Integer> lines, MessagePayload payload) {
        return invoke("modifyGroupInfo", Arrays.asList(groupId, type, value, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<OutputGroupMemberList> getGroupMembers(String groupId) {
        return invoke("getGroupMembers", Arrays.asList(groupId),
                new com.google.gson.reflect.TypeToken<IMResult<OutputGroupMemberList>>(){}.getType());
    }

    public IMResult<PojoGroupMember> getGroupMember(String groupId, String memberId) {
        return invoke("getGroupMember", Arrays.asList(groupId, memberId),
                new com.google.gson.reflect.TypeToken<IMResult<PojoGroupMember>>(){}.getType());
    }

    public IMResult<Void> addGroupMembers(String groupId, List<PojoGroupMember> members, String to, List<Integer> lines, MessagePayload payload) {
        return invoke("addGroupMembers", Arrays.asList(groupId, members, to, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> setGroupManager(String groupId, List<String> members, boolean isManager, List<Integer> lines, MessagePayload payload) {
        return invoke("setGroupManager", Arrays.asList(groupId, members, isManager, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> muteGroupMember(String groupId, List<String> members, boolean mute, List<Integer> lines, MessagePayload payload) {
        return invoke("muteGroupMember", Arrays.asList(groupId, members, mute, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> allowGroupMember(String groupId, List<String> members, boolean allow, List<Integer> lines, MessagePayload payload) {
        return invoke("allowGroupMember", Arrays.asList(groupId, members, allow, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> kickoffGroupMembers(String groupId, List<String> members, List<Integer> lines, MessagePayload payload) {
        return invoke("kickoffGroupMembers", Arrays.asList(groupId, members, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> quitGroup(String groupId, List<Integer> lines, MessagePayload payload) {
        return invoke("quitGroup", Arrays.asList(groupId, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> setGroupMemberAlias(String groupId, String memberId, String alias, List<Integer> lines, MessagePayload payload) {
        return invoke("setGroupMemberAlias", Arrays.asList(groupId, memberId, alias, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> setGroupMemberExtra(String groupId, String memberId, String extra, List<Integer> lines, MessagePayload payload) {
        return invoke("setGroupMemberExtra", Arrays.asList(groupId, memberId, extra, lines, payload),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    // ==================== 朋友圈相关 ====================

    public IMResult<FeedPojo> postMomentsFeed(int type, String text, List<MediaEntry> medias, List<String> mentionUsers, List<String> allowUsers, List<String> denyUsers, String extra) {
        return invoke("postMomentsFeed", Arrays.asList(type, text, medias, mentionUsers, allowUsers, denyUsers, extra),
                new com.google.gson.reflect.TypeToken<IMResult<FeedPojo>>(){}.getType());
    }

    public IMResult<Void> updateMomentsFeed(long feedId, int type, String text, List<MediaEntry> medias, List<String> mentionUsers, List<String> allowUsers, List<String> denyUsers, String extra) {
        return invoke("updateMomentsFeed", Arrays.asList(feedId, type, text, medias, mentionUsers, allowUsers, denyUsers, extra),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<FeedsPojo> getMomentsFeeds(long lastTimestamp, int count, String userId) {
        return invoke("getMomentsFeeds", Arrays.asList(lastTimestamp, count, userId),
                new com.google.gson.reflect.TypeToken<IMResult<FeedsPojo>>(){}.getType());
    }

    public IMResult<FeedPojo> getMomentsFeed(long feedId) {
        return invoke("getMomentsFeed", Arrays.asList(feedId),
                new com.google.gson.reflect.TypeToken<IMResult<FeedPojo>>(){}.getType());
    }

    public IMResult<Void> deleteMomentsFeed(long feedId) {
        return invoke("deleteMomentsFeed", Arrays.asList(feedId),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<CommentPojo> postMomentsComment(long feedId, long commentId, int type, String text, String replyTo, String extra) {
        return invoke("postMomentsComment", Arrays.asList(feedId, commentId, type, text, replyTo, extra),
                new com.google.gson.reflect.TypeToken<IMResult<CommentPojo>>(){}.getType());
    }

    public IMResult<Void> deleteMomentsComment(long feedId, long commentId) {
        return invoke("deleteMomentsComment", Arrays.asList(feedId, commentId),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<MomentProfilePojo> getUserMomentsProfile(String userId) {
        return invoke("getUserMomentsProfile", Arrays.asList(userId),
                new com.google.gson.reflect.TypeToken<IMResult<MomentProfilePojo>>(){}.getType());
    }

    public IMResult<Void> updateMomentsBackgroundUrl(String backgroundUrl) {
        return invoke("updateMomentsBackgroundUrl", Arrays.asList(backgroundUrl),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> updateMomentsStrangerVisibleCount(int count) {
        return invoke("updateMomentsStrangerVisibleCount", Arrays.asList(count),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> updateMomentsVisibleScope(int scope) {
        return invoke("updateMomentsVisibleScope", Arrays.asList(scope),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> updateMomentsBlackList(List<String> addBlackUsers, List<String> removeBlackUsers) {
        return invoke("updateMomentsBlackList", Arrays.asList(addBlackUsers, removeBlackUsers),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public IMResult<Void> updateMomentsBlockList(List<String> addBlockUsers, List<String> removeBlockUsers) {
        return invoke("updateMomentsBlockList", Arrays.asList(addBlockUsers, removeBlockUsers),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    public void close() {
        connectionManager.stop();
    }
}
