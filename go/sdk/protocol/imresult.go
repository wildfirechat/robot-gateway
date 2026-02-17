package protocol

// IMResult represents a generic result from IM service.
type IMResult[T any] struct {
	Code   int    `json:"code"`
	Msg    string `json:"msg"`
	Result T      `json:"result,omitempty"`
}

// IsSuccess returns true if the result indicates success.
func (r *IMResult[T]) IsSuccess() bool {
	return r.Code == 0
}

// InputOutputUserInfo represents user information.
type InputOutputUserInfo struct {
	UserID           string `json:"userId"`
	Name             string `json:"name"`
	DisplayName      string `json:"displayName"`
	Portrait         string `json:"portrait"`
	Mobile           string `json:"mobile"`
	Email            string `json:"email"`
	Address          string `json:"address"`
	Company          string `json:"company"`
	Extra            string `json:"extra"`
	Gender           int    `json:"gender"`
}

// OutputApplicationUserInfo represents application user info.
type OutputApplicationUserInfo struct {
	UserID      string `json:"userId"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Portrait    string `json:"portrait"`
}

// OutputRobot represents robot information.
type OutputRobot struct {
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	Secret   string `json:"secret"`
	Callback string `json:"callback"`
	State    int    `json:"state"`
}

// SendMessageResult represents the result of sending a message.
type SendMessageResult struct {
	MessageID  int64 `json:"messageId"`
	MessageUID int64 `json:"messageUid"`
	Timestamp  int64 `json:"timestamp"`
}

// PojoGroupInfo represents group information.
type PojoGroupInfo struct {
	GroupID       string `json:"groupId"`
	Name          string `json:"name"`
	Portrait      string `json:"portrait"`
	Owner         string `json:"owner"`
	Type          int    `json:"type"`
	MemberCount   int    `json:"memberCount"`
	Extra         string `json:"extra"`
	UpdateDt      int64  `json:"updateDt"`
}

// PojoGroupMember represents a group member.
type PojoGroupMember struct {
	GroupID     string `json:"groupId"`
	MemberID    string `json:"memberId"`
	Alias       string `json:"alias"`
	Extra       string `json:"extra"`
	Type        int    `json:"type"` // 0=normal, 1=manager, 2=owner
	UpdateDt    int64  `json:"updateDt"`
}

// OutputCreateGroupResult represents the result of creating a group.
type OutputCreateGroupResult struct {
	GroupID string `json:"groupId"`
}

// OutputGroupMemberList represents a list of group members.
type OutputGroupMemberList struct {
	Members []PojoGroupMember `json:"members"`
}

// RecallMessageData represents recall message data.
type RecallMessageData struct {
	MessageID int64 `json:"messageId"`
}

// Moments related types

// FeedPojo represents a moments feed.
type FeedPojo struct {
	FeedID    int64  `json:"feedId"`
	UserID    string `json:"userId"`
	Type      int    `json:"type"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
}

// FeedsPojo represents a list of moments feeds.
type FeedsPojo struct {
	Feeds []FeedPojo `json:"feeds"`
}

// CommentPojo represents a moments comment.
type CommentPojo struct {
	CommentID int64  `json:"commentId"`
	FeedID    int64  `json:"feedId"`
	UserID    string `json:"userId"`
	Type      int    `json:"type"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
}

// MomentProfilePojo represents a user's moments profile.
type MomentProfilePojo struct {
	UserID     string `json:"userId"`
	Background string `json:"background"`
}

// MediaEntry represents a media entry in moments.
type MediaEntry struct {
	Type int    `json:"type"` // 1=image, 2=video
	URL  string `json:"url"`
}
