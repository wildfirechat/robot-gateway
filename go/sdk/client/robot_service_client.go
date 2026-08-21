package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/wildfirechat/robot-gateway-sdk/protocol"
)

// RobotServiceClient implements all RobotService methods through the gateway.
type RobotServiceClient struct {
	connectionManager *ConnectionManager
	timeout           time.Duration
}

// NewRobotServiceClient creates a new RobotServiceClient.
func NewRobotServiceClient(gatewayURL string, handler MessageHandler) *RobotServiceClient {
	return NewRobotServiceClientWithTimeout(gatewayURL, handler, 30)
}

// NewRobotServiceClientWithTimeout creates a new RobotServiceClient with custom timeout.
func NewRobotServiceClientWithTimeout(gatewayURL string, handler MessageHandler, timeoutSeconds int) *RobotServiceClient {
	return &RobotServiceClient{
		connectionManager: NewConnectionManager(gatewayURL, handler),
		timeout:           time.Duration(timeoutSeconds) * time.Second,
	}
}

// Connect connects to the gateway and authenticates.
func (c *RobotServiceClient) Connect(robotID, secret string) bool {
	return c.connectionManager.Connect(robotID, secret)
}

// GetRobotID returns the current robot ID.
func (c *RobotServiceClient) GetRobotID() string {
	return c.connectionManager.GetRobotID()
}

// IsConnected returns true if connected to the gateway.
func (c *RobotServiceClient) IsConnected() bool {
	return c.connectionManager.IsConnected()
}

// IsAuthenticated returns true if authenticated.
func (c *RobotServiceClient) IsAuthenticated() bool {
	return c.connectionManager.IsAuthenticated()
}

// IsRunning returns true if the client is running.
func (c *RobotServiceClient) IsRunning() bool {
	return c.connectionManager.IsRunning()
}

// Close closes the client connection.
func (c *RobotServiceClient) Close() {
	c.connectionManager.Stop()
}

// nestedIMResult represents the nested IMResult structure returned by the gateway.
// The gateway wraps the actual IMResult<T> inside ResponseMessage.Result
type nestedIMResult struct {
	Code   int             `json:"code"`
	Msg    string          `json:"msg"`
	Result json.RawMessage `json:"result,omitempty"`
}

// invoke makes a remote call to the gateway.
func invoke[T any](c *RobotServiceClient, method string, params []interface{}) (*protocol.IMResult[T], error) {
	if !c.connectionManager.IsConnected() {
		return &protocol.IMResult[T]{
			Code: -1,
			Msg:  "Not connected to gateway",
		}, nil
	}

	ch, err := c.connectionManager.GetClient().SendRequest(method, params)
	if err != nil {
		return &protocol.IMResult[T]{
			Code: -1,
			Msg:  err.Error(),
		}, nil
	}

	select {
	case resp := <-ch:
		if !resp.IsSuccess() {
			return &protocol.IMResult[T]{
				Code: resp.Code,
				Msg:  resp.Msg,
			}, nil
		}

		// The gateway returns a nested structure: ResponseMessage.Result is an IMResult<T>
		// We need to first parse the nested IMResult, then extract the actual result data
		nested, err := convertResult[nestedIMResult](resp.Result)
		if err != nil {
			return &protocol.IMResult[T]{
				Code: -1,
				Msg:  fmt.Sprintf("Failed to convert nested result: %v", err),
			}, nil
		}

		// Now parse the actual result data from the nested IMResult
		var actualResult T
		if len(nested.Result) > 0 {
			err = json.Unmarshal(nested.Result, &actualResult)
			if err != nil {
				return &protocol.IMResult[T]{
					Code: -1,
					Msg:  fmt.Sprintf("Failed to convert actual result: %v", err),
				}, nil
			}
		}

		return &protocol.IMResult[T]{
			Code:   nested.Code,
			Msg:    nested.Msg,
			Result: actualResult,
		}, nil

	case <-time.After(c.timeout):
		return &protocol.IMResult[T]{
			Code: -1,
			Msg:  "Request timeout",
		}, nil
	}
}

// convertResult converts an interface{} to the target type.
func convertResult[T any](data interface{}) (T, error) {
	var result T
	if data == nil {
		return result, nil
	}

	// Use JSON marshaling/unmarshaling for type conversion
	jsonData, err := json.Marshal(data)
	if err != nil {
		return result, err
	}

	err = json.Unmarshal(jsonData, &result)
	return result, err
}

// ==================== Message Related ====================

// SendMessage sends a message.
func (c *RobotServiceClient) SendMessage(conv *protocol.Conversation, payload *protocol.MessagePayload) (*protocol.IMResult[protocol.SendMessageResult], error) {
	params := []interface{}{c.GetRobotID(), conv, payload}
	return invoke[protocol.SendMessageResult](c, "sendMessage", params)
}

// SendMessageWithUsers sends a message to specific users.
func (c *RobotServiceClient) SendMessageWithUsers(conv *protocol.Conversation, payload *protocol.MessagePayload, toUsers []string) (*protocol.IMResult[protocol.SendMessageResult], error) {
	params := []interface{}{c.GetRobotID(), conv, payload, toUsers}
	return invoke[protocol.SendMessageResult](c, "sendMessage", params)
}

// ReplyMessage replies to a message.
func (c *RobotServiceClient) ReplyMessage(messageID int64, payload *protocol.MessagePayload, mentionSender bool) (*protocol.IMResult[protocol.SendMessageResult], error) {
	params := []interface{}{messageID, payload, mentionSender}
	return invoke[protocol.SendMessageResult](c, "replyMessage", params)
}

// RecallMessage recalls a message.
func (c *RobotServiceClient) RecallMessage(messageID int64) (*protocol.IMResult[string], error) {
	params := []interface{}{messageID}
	return invoke[string](c, "recallMessage", params)
}

// UpdateMessage updates a message.
func (c *RobotServiceClient) UpdateMessage(messageID int64, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{messageID, payload}
	return invoke[struct{}](c, "updateMessage", params)
}

// UpdateConversationUserSetting 设置会话级用户设置（scope=31），会话内所有用户（机器人除外）
// 都会收到 key 为 convType-line-target_type 的用户设置变更。
// conv 为会话（私聊 target 为对方 uid，群聊 target 为 groupId）；settingType 为设置类型；value 为 JSON 字符串。
func (c *RobotServiceClient) UpdateConversationUserSetting(conv *protocol.Conversation, settingType int, value string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{conv, settingType, value}
	return invoke[struct{}](c, "updateConversationUserSetting", params)
}

// ==================== User Related ====================

// GetUserInfo gets user information.
func (c *RobotServiceClient) GetUserInfo(userID string) (*protocol.IMResult[protocol.InputOutputUserInfo], error) {
	params := []interface{}{userID}
	return invoke[protocol.InputOutputUserInfo](c, "getUserInfo", params)
}

// GetUserInfoByMobile gets user information by mobile number.
func (c *RobotServiceClient) GetUserInfoByMobile(mobile string) (*protocol.IMResult[protocol.InputOutputUserInfo], error) {
	params := []interface{}{mobile}
	return invoke[protocol.InputOutputUserInfo](c, "getUserInfoByMobile", params)
}

// GetUserInfoByName gets user information by name.
func (c *RobotServiceClient) GetUserInfoByName(name string) (*protocol.IMResult[protocol.InputOutputUserInfo], error) {
	params := []interface{}{name}
	return invoke[protocol.InputOutputUserInfo](c, "getUserInfoByName", params)
}

// GetUserInfoByEmail gets user information by email.
func (c *RobotServiceClient) GetUserInfoByEmail(email string) (*protocol.IMResult[protocol.OutputUserInfoList], error) {
	params := []interface{}{email}
	return invoke[protocol.OutputUserInfoList](c, "getUserInfoByEmail", params)
}

// GetBatchUsers gets user information in batch.
func (c *RobotServiceClient) GetBatchUsers(userIDs []string) (*protocol.IMResult[protocol.OutputUserInfoList], error) {
	params := []interface{}{userIDs}
	return invoke[protocol.OutputUserInfoList](c, "getBatchUsers", params)
}

// ApplicationGetUserInfo gets user information as an application.
func (c *RobotServiceClient) ApplicationGetUserInfo(userID string) (*protocol.IMResult[protocol.OutputApplicationUserInfo], error) {
	params := []interface{}{userID}
	return invoke[protocol.OutputApplicationUserInfo](c, "applicationGetUserInfo", params)
}

// GetFriendList gets the robot owner's friend list.
func (c *RobotServiceClient) GetOwnerFriendList() (*protocol.IMResult[protocol.OutputGetFriendList], error) {
	params := []interface{}{}
	return invoke[protocol.OutputGetFriendList](c, "getOwnerFriendList", params)
}

// SearchUserByDisplayName searches users by display name.
func (c *RobotServiceClient) SearchUserByDisplayName(keyword string) (*protocol.IMResult[protocol.PojoSearchUserRes], error) {
	params := []interface{}{keyword}
	return invoke[protocol.PojoSearchUserRes](c, "searchUserByDisplayName", params)
}

// GetUserRobots gets the list of robots owned by a user.
func (c *RobotServiceClient) GetUserRobots(userID string) (*protocol.IMResult[protocol.OutputGetRobotList], error) {
	params := []interface{}{userID}
	return invoke[protocol.OutputGetRobotList](c, "getUserRobots", params)
}

// ==================== Robot Profile ====================

// GetProfile gets the robot's profile.
func (c *RobotServiceClient) GetProfile() (*protocol.IMResult[protocol.OutputRobot], error) {
	params := []interface{}{}
	return invoke[protocol.OutputRobot](c, "getProfile", params)
}

// UpdateProfile updates the robot's profile.
func (c *RobotServiceClient) UpdateProfile(updateType int, value string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{updateType, value}
	return invoke[struct{}](c, "updateProfile", params)
}

// ==================== Group Related ====================

// CreateGroup creates a new group.
func (c *RobotServiceClient) CreateGroup(groupInfo *protocol.PojoGroupInfo, members []protocol.PojoGroupMember, to string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[protocol.OutputCreateGroupResult], error) {
	params := []interface{}{groupInfo, members, to, lines, payload}
	return invoke[protocol.OutputCreateGroupResult](c, "createGroup", params)
}

// GetGroupInfo gets group information.
func (c *RobotServiceClient) GetGroupInfo(groupID string) (*protocol.IMResult[protocol.PojoGroupInfo], error) {
	params := []interface{}{groupID}
	return invoke[protocol.PojoGroupInfo](c, "getGroupInfo", params)
}

// DismissGroup dismisses a group.
func (c *RobotServiceClient) DismissGroup(groupID string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, lines, payload}
	return invoke[struct{}](c, "dismissGroup", params)
}

// TransferGroup transfers group ownership.
func (c *RobotServiceClient) TransferGroup(groupID, newOwner string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, newOwner, lines, payload}
	return invoke[struct{}](c, "transferGroup", params)
}

// ModifyGroupInfo modifies group information.
func (c *RobotServiceClient) ModifyGroupInfo(groupID string, modifyType int, value string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, modifyType, value, lines, payload}
	return invoke[struct{}](c, "modifyGroupInfo", params)
}

// GetGroupMembers gets group members.
func (c *RobotServiceClient) GetGroupMembers(groupID string) (*protocol.IMResult[protocol.OutputGroupMemberList], error) {
	params := []interface{}{groupID}
	return invoke[protocol.OutputGroupMemberList](c, "getGroupMembers", params)
}

// GetGroupMember gets a specific group member.
func (c *RobotServiceClient) GetGroupMember(groupID, memberID string) (*protocol.IMResult[protocol.PojoGroupMember], error) {
	params := []interface{}{groupID, memberID}
	return invoke[protocol.PojoGroupMember](c, "getGroupMember", params)
}

// AddGroupMembers adds members to a group.
func (c *RobotServiceClient) AddGroupMembers(groupID string, members []protocol.PojoGroupMember, to string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, members, to, lines, payload}
	return invoke[struct{}](c, "addGroupMembers", params)
}

// SetGroupManager sets or removes managers.
func (c *RobotServiceClient) SetGroupManager(groupID string, members []string, isManager bool, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, members, isManager, lines, payload}
	return invoke[struct{}](c, "setGroupManager", params)
}

// MuteGroupMember mutes or unmutes group members.
func (c *RobotServiceClient) MuteGroupMember(groupID string, members []string, mute bool, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, members, mute, lines, payload}
	return invoke[struct{}](c, "muteGroupMember", params)
}

// AllowGroupMember allows or blocks group members.
func (c *RobotServiceClient) AllowGroupMember(groupID string, members []string, allow bool, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, members, allow, lines, payload}
	return invoke[struct{}](c, "allowGroupMember", params)
}

// KickoffGroupMembers removes members from a group.
func (c *RobotServiceClient) KickoffGroupMembers(groupID string, members []string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, members, lines, payload}
	return invoke[struct{}](c, "kickoffGroupMembers", params)
}

// QuitGroup makes the robot quit a group.
func (c *RobotServiceClient) QuitGroup(groupID string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, lines, payload}
	return invoke[struct{}](c, "quitGroup", params)
}

// SetGroupMemberAlias sets a member's alias in the group.
func (c *RobotServiceClient) SetGroupMemberAlias(groupID, memberID, alias string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, memberID, alias, lines, payload}
	return invoke[struct{}](c, "setGroupMemberAlias", params)
}

// SetGroupMemberExtra sets a member's extra data in the group.
func (c *RobotServiceClient) SetGroupMemberExtra(groupID, memberID, extra string, lines []int, payload *protocol.MessagePayload) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{groupID, memberID, extra, lines, payload}
	return invoke[struct{}](c, "setGroupMemberExtra", params)
}

// ==================== Moments Related ====================

// PostMomentsFeed posts a new moments feed.
func (c *RobotServiceClient) PostMomentsFeed(feedType int, text string, medias []protocol.MediaEntry, mentionUsers, allowUsers, denyUsers []string, extra string) (*protocol.IMResult[protocol.FeedPojo], error) {
	params := []interface{}{feedType, text, medias, mentionUsers, allowUsers, denyUsers, extra}
	return invoke[protocol.FeedPojo](c, "postMomentsFeed", params)
}

// UpdateMomentsFeed updates a moments feed.
func (c *RobotServiceClient) UpdateMomentsFeed(feedID int64, feedType int, text string, medias []protocol.MediaEntry, mentionUsers, allowUsers, denyUsers []string, extra string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{feedID, feedType, text, medias, mentionUsers, allowUsers, denyUsers, extra}
	return invoke[struct{}](c, "updateMomentsFeed", params)
}

// GetMomentsFeeds gets a list of moments feeds.
func (c *RobotServiceClient) GetMomentsFeeds(lastTimestamp int64, count int, userID string) (*protocol.IMResult[protocol.FeedsPojo], error) {
	params := []interface{}{lastTimestamp, count, userID}
	return invoke[protocol.FeedsPojo](c, "getMomentsFeeds", params)
}

// GetMomentsFeed gets a single moments feed.
func (c *RobotServiceClient) GetMomentsFeed(feedID int64) (*protocol.IMResult[protocol.FeedPojo], error) {
	params := []interface{}{feedID}
	return invoke[protocol.FeedPojo](c, "getMomentsFeed", params)
}

// DeleteMomentsFeed deletes a moments feed.
func (c *RobotServiceClient) DeleteMomentsFeed(feedID int64) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{feedID}
	return invoke[struct{}](c, "deleteMomentsFeed", params)
}

// PostMomentsComment posts a comment on a moments feed.
func (c *RobotServiceClient) PostMomentsComment(feedID, commentID int64, commentType int, text, replyTo, extra string) (*protocol.IMResult[protocol.CommentPojo], error) {
	params := []interface{}{feedID, commentID, commentType, text, replyTo, extra}
	return invoke[protocol.CommentPojo](c, "postMomentsComment", params)
}

// DeleteMomentsComment deletes a comment from a moments feed.
func (c *RobotServiceClient) DeleteMomentsComment(feedID, commentID int64) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{feedID, commentID}
	return invoke[struct{}](c, "deleteMomentsComment", params)
}

// GetUserMomentsProfile gets a user's moments profile.
func (c *RobotServiceClient) GetUserMomentsProfile(userID string) (*protocol.IMResult[protocol.MomentProfilePojo], error) {
	params := []interface{}{userID}
	return invoke[protocol.MomentProfilePojo](c, "getUserMomentsProfile", params)
}

// UpdateMomentsBackgroundUrl updates the moments background URL.
func (c *RobotServiceClient) UpdateMomentsBackgroundUrl(backgroundURL string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{backgroundURL}
	return invoke[struct{}](c, "updateMomentsBackgroundUrl", params)
}

// UpdateMomentsStrangerVisibleCount updates the stranger visible count.
func (c *RobotServiceClient) UpdateMomentsStrangerVisibleCount(count int) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{count}
	return invoke[struct{}](c, "updateMomentsStrangerVisibleCount", params)
}

// UpdateMomentsVisibleScope updates the visible scope.
func (c *RobotServiceClient) UpdateMomentsVisibleScope(scope int) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{scope}
	return invoke[struct{}](c, "updateMomentsVisibleScope", params)
}

// UpdateMomentsBlackList updates the blacklist.
func (c *RobotServiceClient) UpdateMomentsBlackList(addBlackUsers, removeBlackUsers []string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{addBlackUsers, removeBlackUsers}
	return invoke[struct{}](c, "updateMomentsBlackList", params)
}

// UpdateMomentsBlockList updates the block list.
func (c *RobotServiceClient) UpdateMomentsBlockList(addBlockUsers, removeBlockUsers []string) (*protocol.IMResult[struct{}], error) {
	params := []interface{}{addBlockUsers, removeBlockUsers}
	return invoke[struct{}](c, "updateMomentsBlockList", params)
}

// ==================== File Upload Related ====================

// GetPresignedUploadUrl gets a presigned upload URL.
func (c *RobotServiceClient) GetPresignedUploadUrl(fileName string, messageContentMediaType int, mimeType string) (*protocol.IMResult[protocol.OutputPresignedUploadUrl], error) {
	params := []interface{}{fileName, messageContentMediaType, mimeType}
	return invoke[protocol.OutputPresignedUploadUrl](c, "getPresignedUploadUrl", params)
}

// UploadFile uploads a file (supports Qiniu and other object storage).
// It first gets a presigned upload URL, then uploads directly to the storage service.
func (c *RobotServiceClient) UploadFile(fileData []byte, fileName string, messageContentMediaType int, mimeType string) (*protocol.IMResult[string], error) {
	if len(fileData) == 0 {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  "File data is empty",
		}, nil
	}

	// Infer media type from file name if not provided
	if mimeType == "" {
		mimeType = getContentTypeByFileName(fileName)
	}

	// 1. Get presigned upload URL
	presignedResult, err := c.GetPresignedUploadUrl(fileName, messageContentMediaType, mimeType)
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to get presigned URL: %v", err),
		}, nil
	}

	if !presignedResult.IsSuccess() {
		return &protocol.IMResult[string]{
			Code: presignedResult.Code,
			Msg:  presignedResult.Msg,
		}, nil
	}

	presignedUrl := presignedResult.Result
	if presignedUrl.UploadURL == "" {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  "Upload URL is empty",
		}, nil
	}

	// 2. Upload based on storage type
	if presignedUrl.Type == 1 {
		// Qiniu upload
		return c.uploadToQiniu(&presignedUrl, fileData, fileName, mimeType)
	}
	// Other storage (S3/OSS)
	return c.uploadToOther(&presignedUrl, fileData, mimeType)
}

// uploadToQiniu uploads file to Qiniu using multipart/form-data.
func (c *RobotServiceClient) uploadToQiniu(presignedURL *protocol.OutputPresignedUploadUrl, fileData []byte, fileName, mimeType string) (*protocol.IMResult[string], error) {
	uploadURL := presignedURL.UploadURL

	// Parse URL: format is "http://host?token?key"
	firstQuestion := -1
	secondQuestion := -1
	for i, ch := range uploadURL {
		if ch == '?' {
			if firstQuestion == -1 {
				firstQuestion = i
			} else if secondQuestion == -1 {
				secondQuestion = i
				break
			}
		}
	}

	if firstQuestion == -1 || secondQuestion == -1 {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  "Invalid Qiniu upload URL format",
		}, nil
	}

	serverURL := uploadURL[:firstQuestion]
	token := uploadURL[firstQuestion+1 : secondQuestion]
	key := uploadURL[secondQuestion+1:]

	// Build multipart form data
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	// Add token and key
	writer.WriteField("token", token)
	writer.WriteField("key", key)

	// Add file
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to create form file: %v", err),
		}, nil
	}
	part.Write(fileData)
	writer.Close()

	// Create request
	req, err := http.NewRequest("POST", serverURL, body)
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to create request: %v", err),
		}, nil
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	// Execute request
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to upload to Qiniu: %v", err),
		}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == 200 || resp.StatusCode == 201 {
		return &protocol.IMResult[string]{
			Code:   0,
			Msg:    "success",
			Result: presignedURL.DownloadURL,
		}, nil
	}

	return &protocol.IMResult[string]{
		Code: -1,
		Msg:  fmt.Sprintf("Upload to Qiniu failed, HTTP status: %d", resp.StatusCode),
	}, nil
}

// uploadToOther uploads file to generic storage (S3/OSS) using HTTP PUT.
func (c *RobotServiceClient) uploadToOther(presignedURL *protocol.OutputPresignedUploadUrl, fileData []byte, mimeType string) (*protocol.IMResult[string], error) {
	// Try primary URL first
	req, err := http.NewRequest("PUT", presignedURL.UploadURL, bytes.NewReader(fileData))
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to create request: %v", err),
		}, nil
	}
	req.Header.Set("Content-Type", mimeType)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return &protocol.IMResult[string]{
			Code: -1,
			Msg:  fmt.Sprintf("Failed to upload: %v", err),
		}, nil
	}
	resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return &protocol.IMResult[string]{
			Code:   0,
			Msg:    "success",
			Result: presignedURL.DownloadURL,
		}, nil
	}

	// Primary URL failed, try backup URL if available
	if presignedURL.BackupUploadURL != "" {
		req, err = http.NewRequest("PUT", presignedURL.BackupUploadURL, bytes.NewReader(fileData))
		if err != nil {
			return &protocol.IMResult[string]{
				Code: -1,
				Msg:  fmt.Sprintf("Failed to create backup request: %v", err),
			}, nil
		}
		req.Header.Set("Content-Type", mimeType)

		resp, err = client.Do(req)
		if err != nil {
			return &protocol.IMResult[string]{
				Code: -1,
				Msg:  fmt.Sprintf("Failed to upload to backup URL: %v", err),
			}, nil
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return &protocol.IMResult[string]{
				Code:   0,
				Msg:    "success",
				Result: presignedURL.DownloadURL,
			}, nil
		}
	}

	return &protocol.IMResult[string]{
		Code: -1,
		Msg:  fmt.Sprintf("Upload failed, HTTP status: %d", resp.StatusCode),
	}, nil
}

// getContentTypeByFileName returns the content type based on file extension.
func getContentTypeByFileName(fileName string) string {
	if fileName == "" {
		return "application/octet-stream"
	}

	lowerName := ""
	for _, ch := range fileName {
		if ch >= 'A' && ch <= 'Z' {
			lowerName += string(ch + 32)
		} else {
			lowerName += string(ch)
		}
	}

	extToMime := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".bmp":  "image/bmp",
		".webp": "image/webp",
		".mp4":  "video/mp4",
		".mov":  "video/quicktime",
		".avi":  "video/x-msvideo",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".pdf":  "application/pdf",
		".doc":  "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls":  "application/vnd.ms-excel",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt":  "application/vnd.ms-powerpoint",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".txt":  "text/plain",
		".zip":  "application/zip",
		".tar":  "application/x-tar",
		".gz":   "application/gzip",
	}

	for ext, mimeType := range extToMime {
		if len(lowerName) >= len(ext) && lowerName[len(lowerName)-len(ext):] == ext {
			return mimeType
		}
	}

	return "application/octet-stream"
}
