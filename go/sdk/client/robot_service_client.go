package client

import (
	"encoding/json"
	"fmt"
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

// ApplicationGetUserInfo gets user information as an application.
func (c *RobotServiceClient) ApplicationGetUserInfo(userID string) (*protocol.IMResult[protocol.OutputApplicationUserInfo], error) {
	params := []interface{}{userID}
	return invoke[protocol.OutputApplicationUserInfo](c, "applicationGetUserInfo", params)
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
