package cn.wildfirechat.client;

import cn.wildfirechat.client.handler.MessageHandler;
import cn.wildfirechat.client.protocol.ResponseMessage;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.pojos.mesh.PojoSearchUserReq;
import cn.wildfirechat.pojos.mesh.PojoSearchUserRes;
import cn.wildfirechat.pojos.moments.CommentPojo;
import cn.wildfirechat.pojos.moments.FeedsPojo;
import cn.wildfirechat.pojos.moments.FeedPojo;
import cn.wildfirechat.pojos.moments.MediaEntry;
import cn.wildfirechat.pojos.moments.MomentProfilePojo;
import cn.wildfirechat.sdk.model.IMResult;
import com.google.gson.Gson;
import org.apache.http.HttpResponse;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.methods.HttpPut;
import org.apache.http.entity.ContentType;
import org.apache.http.entity.FileEntity;
import org.apache.http.entity.InputStreamEntity;
import org.apache.http.entity.mime.MultipartEntityBuilder;
import org.apache.http.entity.mime.content.FileBody;
import org.apache.http.entity.mime.content.InputStreamBody;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.util.EntityUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
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

    /**
     * 连接并鉴权（带平台号）
     * @param robotId 机器人ID
     * @param secret 机器人密钥
     * @param platform 机器人平台号（ProtoConstants.Platform：7=Linux, 5=WEB ...），null = 网关默认
     * @return 鉴权是否成功
     */
    public boolean connect(String robotId, String secret, Integer platform) {
        return connectionManager.connect(robotId, secret, platform);
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

    public IMResult<Void> updateMessage(long messageId, MessagePayload payload, boolean distribute) {
        return invoke("updateMessage", Arrays.asList(messageId, payload, distribute),
                new com.google.gson.reflect.TypeToken<IMResult<Void>>(){}.getType());
    }

    /**
     * 获取单条消息（只能获取机器人参与会话中的消息）。
     * messageUid 为 long，Java 原生无精度问题（JS 端需用字符串，见 JS SDK getMessage）。
     * @param messageUid 消息 uid
     * @return 消息数据（payload.searchableContent 为文本正文；引用被引原文取此处）
     */
    public IMResult<OutputMessageData> getMessage(long messageUid) {
        return invoke("getMessage", Arrays.asList(messageUid),
                new com.google.gson.reflect.TypeToken<IMResult<OutputMessageData>>(){}.getType());
    }

    /**
     * 设置会话级用户设置（scope=31），会话内所有用户（机器人除外）都会收到
     * key为convType-line-target_type的用户设置变更
     * @param conversation 会话；私聊target为对方用户uid，群聊target为groupId
     * @param type 设置类型
     * @param value 设置值，JSON字符串
     * @return 设置结果
     */
    public IMResult<Void> updateConversationUserSetting(Conversation conversation, int type, String value) {
        return invoke("updateConversationUserSetting", Arrays.asList(conversation, type, value),
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

    public IMResult<OutputUserInfoList> getUserInfoByEmail(String email) {
        return invoke("getUserInfoByEmail", Arrays.asList(email),
                new com.google.gson.reflect.TypeToken<IMResult<OutputUserInfoList>>(){}.getType());
    }

    public IMResult<OutputUserInfoList> getBatchUsers(List<String> userIds) {
        return invoke("getBatchUsers", Arrays.asList(userIds),
                new com.google.gson.reflect.TypeToken<IMResult<OutputUserInfoList>>(){}.getType());
    }

    public IMResult<OutputApplicationUserInfo> applicationGetUserInfo(String userId) {
        return invoke("applicationGetUserInfo", Arrays.asList(userId),
                new com.google.gson.reflect.TypeToken<IMResult<OutputApplicationUserInfo>>(){}.getType());
    }

    public IMResult<String> sendConferenceRequest(String userId, String clientId, String request, long sessionId, String roomId, String data, boolean advance) {
        return invoke("sendConferenceRequest", Arrays.asList(userId, clientId, request, sessionId, roomId, data, advance),
                new com.google.gson.reflect.TypeToken<IMResult<String>>(){}.getType());
    }

    // ==================== 好友相关 ====================

    public IMResult<OutputGetFriendList> getOwnerFriendList() {
        return invoke("getOwnerFriendList", null,
                new com.google.gson.reflect.TypeToken<IMResult<OutputGetFriendList>>(){}.getType());
    }

    public IMResult<PojoSearchUserRes> searchUserByDisplayName(String keyword) {
        return invoke("searchUserByDisplayName", Arrays.asList(keyword),
                new com.google.gson.reflect.TypeToken<IMResult<PojoSearchUserRes>>(){}.getType());
    }

    public IMResult<OutputGetRobotList> getUserRobots(String userId) {
        return invoke("getUserRobots", Arrays.asList(userId),
                new com.google.gson.reflect.TypeToken<IMResult<OutputGetRobotList>>(){}.getType());
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

    // ==================== 文件上传相关 ====================

    /**
     * 获取预签名上传URL
     * @param fileName 文件名
     * @param messageContentMediaType 消息内容媒体类型
     * @param mimeType Http的ContentType Header，可以为空，为空时默认为"application/octet-stream"
     * @return 预签名上传URL结果
     */
    public IMResult<OutputPresignedUploadUrl> getPresignedUploadUrl(String fileName, int messageContentMediaType, String mimeType) {
        return invoke("getPresignedUploadUrl", Arrays.asList(fileName, messageContentMediaType, mimeType),
                new com.google.gson.reflect.TypeToken<IMResult<OutputPresignedUploadUrl>>(){}.getType());
    }

    /**
     * 上传文件
     * 先获取预签名上传URL，然后直接上传到存储服务
     * @param file 要上传的文件
     * @return 上传后的下载URL
     */
    public IMResult<String> uploadFile(File file) {
        return uploadFile(file, 4, null);
    }

    /**
     * 上传文件
     * 先获取预签名上传URL，然后直接上传到存储服务
     * @param file 要上传的文件
     * @param messageContentMediaType 消息内容媒体类型
     * @param mimeType 媒体类型
     * @return 上传后的下载URL
     */
    public IMResult<String> uploadFile(File file, int messageContentMediaType, String mimeType) {
        if (file == null || !file.exists()) {
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("文件不能为空或不存在");
            return result;
        }

        // 如果mediaType为空，根据文件名推断
        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = getContentTypeByFileName(file.getName());
        }

        try {
            return doUploadFile(file.getName(), messageContentMediaType, mimeType, file, null);
        } catch (Exception e) {
            LOG.error("上传文件失败: {}", e.getMessage(), e);
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("上传文件失败: " + e.getMessage());
            return result;
        }
    }

    /**
     * 上传文件
     * 先获取预签名上传URL，然后直接上传到存储服务
     * @param inputStream 文件输入流
     * @param fileName 文件名
     * @return 上传后的下载URL
     */
    public IMResult<String> uploadFile(InputStream inputStream, String fileName) {
        return uploadFile(inputStream, fileName, 4, null);
    }

    /**
     * 上传文件
     * 先获取预签名上传URL，然后直接上传到存储服务
     * @param inputStream 文件输入流
     * @param fileName 文件名
     * @param messageContentMediaType 消息内容媒体类型
     * @param mimeType 媒体类型
     * @return 上传后的下载URL
     */
    public IMResult<String> uploadFile(InputStream inputStream, String fileName, int messageContentMediaType, String mimeType) {
        if (inputStream == null) {
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("输入流不能为空");
            return result;
        }

        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = getContentTypeByFileName(fileName);
        }

        try {
            return doUploadFile(fileName, messageContentMediaType, mimeType, null, inputStream);
        } catch (Exception e) {
            LOG.error("上传文件失败: {}", e.getMessage(), e);
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("上传文件失败: " + e.getMessage());
            return result;
        }
    }

    /**
     * 执行文件上传
     * 根据存储类型区分：1=七牛云，其他=通用S3/OSS
     * @param fileName 文件名
     * @param messageContentMediaType 媒体消息媒体类型
     * @param mimeType 媒体类型
     * @param file 文件对象（与inputStream二选一）
     * @param inputStream 输入流（与file二选一）
     * @return 上传后的下载URL
     * @throws Exception 上传过程中的异常
     */
    private IMResult<String> doUploadFile(String fileName, int messageContentMediaType, String mimeType, File file, InputStream inputStream) throws Exception {

        // 1. 获取预签名上传URL
        IMResult<OutputPresignedUploadUrl> presignedResult = getPresignedUploadUrl(fileName, messageContentMediaType, mimeType);
        if (presignedResult.getErrorCode() != cn.wildfirechat.common.ErrorCode.ERROR_CODE_SUCCESS) {
            IMResult<String> result = new IMResult<>();
            result.setCode(presignedResult.getCode());
            result.setMsg(presignedResult.getMsg());
            return result;
        }

        OutputPresignedUploadUrl presignedUrl = presignedResult.getResult();
        if (presignedUrl == null || presignedUrl.uploadUrl == null || presignedUrl.uploadUrl.isEmpty()) {
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("获取上传URL失败");
            return result;
        }

        // 2. 根据存储类型选择上传方式
        if (presignedUrl.type == 1) {
            // 七牛云上传
            return uploadToQiniu(presignedUrl, file, inputStream, fileName, mimeType);
        } else {
            // 其他存储（S3/OSS等）
            return uploadToOther(presignedUrl, file, inputStream, mimeType);
        }
    }

    /**
     * 上传到七牛云
     * 使用multipart/form-data格式，需要解析URL获取token和key
     */
    private IMResult<String> uploadToQiniu(OutputPresignedUploadUrl presignedUrl, File file, InputStream inputStream, String fileName, String mimeType) throws Exception {
        String uploadUrl = presignedUrl.uploadUrl;

        // 解析URL：格式为 "http://host?token?key"
        int firstQuestion = uploadUrl.indexOf('?');
        int secondQuestion = uploadUrl.indexOf('?', firstQuestion + 1);

        if (firstQuestion == -1 || secondQuestion == -1) {
            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("七牛云上传地址格式错误");
            return result;
        }

        String serverUrl = uploadUrl.substring(0, firstQuestion);
        String token = uploadUrl.substring(firstQuestion + 1, secondQuestion);
        String key = uploadUrl.substring(secondQuestion + 1);

        HttpPost httpPost = new HttpPost(serverUrl);
        CloseableHttpClient httpClient = null;
        CloseableHttpResponse response = null;

        try {
            // 构建multipart请求体
            MultipartEntityBuilder builder = MultipartEntityBuilder.create();
            builder.addTextBody("token", token);
            builder.addTextBody("key", key);

            if (file != null) {
                builder.addPart("file", new FileBody(file, ContentType.create(mimeType), fileName));
            } else if (inputStream != null) {
                builder.addPart("file", new InputStreamBody(inputStream, ContentType.create(mimeType), fileName));
            }

            httpPost.setEntity(builder.build());

            httpClient = HttpClients.createDefault();
            response = httpClient.execute(httpPost);
            int statusCode = response.getStatusLine().getStatusCode();

            // 消耗响应实体
            EntityUtils.consumeQuietly(response.getEntity());

            if (statusCode == 200 || statusCode == 201) {
                IMResult<String> result = new IMResult<>();
                result.setCode(0);
                result.setResult(presignedUrl.downloadUrl);
                return result;
            } else {
                IMResult<String> result = new IMResult<>();
                result.setCode(-1);
                result.setMsg("文件上传到七牛云失败，HTTP状态码: " + statusCode);
                return result;
            }
        } finally {
            if (response != null) {
                try {
                    response.close();
                } catch (IOException ignored) {}
            }
            if (httpClient != null) {
                try {
                    httpClient.close();
                } catch (IOException ignored) {}
            }
            httpPost.releaseConnection();
        }
    }

    /**
     * 上传到通用存储（S3/OSS等）
     * 使用HTTP PUT直接上传
     */
    private IMResult<String> uploadToOther(OutputPresignedUploadUrl presignedUrl, File file, InputStream inputStream, String mimeType) throws Exception {
        CloseableHttpClient httpClient = null;
        CloseableHttpResponse response = null;

        try {
            httpClient = HttpClients.createDefault();

            // 先尝试主上传URL
            HttpPut httpPut = new HttpPut(presignedUrl.uploadUrl);
            httpPut.setHeader("Content-Type", mimeType);

            if (file != null) {
                FileEntity entity = new FileEntity(file);
                entity.setContentType(mimeType);
                httpPut.setEntity(entity);
            } else if (inputStream != null) {
                InputStreamEntity entity = new InputStreamEntity(inputStream);
                entity.setContentType(mimeType);
                httpPut.setEntity(entity);
            }

            response = httpClient.execute(httpPut);
            int statusCode = response.getStatusLine().getStatusCode();

            if (statusCode >= 200 && statusCode < 300) {
                EntityUtils.consumeQuietly(response.getEntity());
                IMResult<String> result = new IMResult<>();
                result.setCode(0);
                result.setResult(presignedUrl.downloadUrl);
                return result;
            }

            EntityUtils.consumeQuietly(response.getEntity());
            response.close();

            // 主URL失败，尝试备用URL
            if (presignedUrl.backupUploadUrl != null && !presignedUrl.backupUploadUrl.isEmpty()) {
                httpPut = new HttpPut(presignedUrl.backupUploadUrl);
                httpPut.setHeader("Content-Type", mimeType);

                if (file != null) {
                    FileEntity entity = new FileEntity(file);
                    entity.setContentType(mimeType);
                    httpPut.setEntity(entity);
                } else {
                    // 输入流无法重用，返回错误
                    IMResult<String> result = new IMResult<>();
                    result.setCode(-1);
                    result.setMsg("主上传URL失败，无法使用备用URL（输入流无法重用）");
                    return result;
                }

                response = httpClient.execute(httpPut);
                statusCode = response.getStatusLine().getStatusCode();
                EntityUtils.consumeQuietly(response.getEntity());

                if (statusCode >= 200 && statusCode < 300) {
                    IMResult<String> result = new IMResult<>();
                    result.setCode(0);
                    result.setResult(presignedUrl.downloadUrl);
                    return result;
                }
            }

            IMResult<String> result = new IMResult<>();
            result.setCode(-1);
            result.setMsg("上传文件失败，HTTP状态码: " + statusCode);
            return result;

        } finally {
            if (response != null) {
                try {
                    response.close();
                } catch (IOException ignored) {}
            }
            if (httpClient != null) {
                try {
                    httpClient.close();
                } catch (IOException ignored) {}
            }
        }
    }

    /**
     * 根据文件名获取Content-Type
     * @param fileName 文件名
     * @return Content-Type
     */
    private String getContentTypeByFileName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return "application/octet-stream";
        }

        String lowerCaseName = fileName.toLowerCase();
        if (lowerCaseName.endsWith(".jpg") || lowerCaseName.endsWith(".jpeg")) {
            return "image/jpeg";
        } else if (lowerCaseName.endsWith(".png")) {
            return "image/png";
        } else if (lowerCaseName.endsWith(".gif")) {
            return "image/gif";
        } else if (lowerCaseName.endsWith(".bmp")) {
            return "image/bmp";
        } else if (lowerCaseName.endsWith(".webp")) {
            return "image/webp";
        } else if (lowerCaseName.endsWith(".mp4")) {
            return "video/mp4";
        } else if (lowerCaseName.endsWith(".mov")) {
            return "video/quicktime";
        } else if (lowerCaseName.endsWith(".avi")) {
            return "video/x-msvideo";
        } else if (lowerCaseName.endsWith(".mp3")) {
            return "audio/mpeg";
        } else if (lowerCaseName.endsWith(".wav")) {
            return "audio/wav";
        } else if (lowerCaseName.endsWith(".pdf")) {
            return "application/pdf";
        } else if (lowerCaseName.endsWith(".doc")) {
            return "application/msword";
        } else if (lowerCaseName.endsWith(".docx")) {
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        } else if (lowerCaseName.endsWith(".xls")) {
            return "application/vnd.ms-excel";
        } else if (lowerCaseName.endsWith(".xlsx")) {
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        } else if (lowerCaseName.endsWith(".ppt")) {
            return "application/vnd.ms-powerpoint";
        } else if (lowerCaseName.endsWith(".pptx")) {
            return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        } else if (lowerCaseName.endsWith(".txt")) {
            return "text/plain";
        } else if (lowerCaseName.endsWith(".zip")) {
            return "application/zip";
        } else if (lowerCaseName.endsWith(".tar")) {
            return "application/x-tar";
        } else if (lowerCaseName.endsWith(".gz")) {
            return "application/gzip";
        } else {
            return "application/octet-stream";
        }
    }

    public void close() {
        connectionManager.stop();
    }
}
