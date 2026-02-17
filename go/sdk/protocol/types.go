// Package protocol defines the message protocol for robot gateway communication.
package protocol

// RequestMessage represents a request from client to gateway.
type RequestMessage struct {
	RequestID string        `json:"requestId"`
	Method    string        `json:"method"`
	Params    []interface{} `json:"params,omitempty"`
}

// ResponseMessage represents a response from gateway to client.
type ResponseMessage struct {
	RequestID string      `json:"requestId"`
	Code      int         `json:"code"`
	Msg       string      `json:"msg"`
	Result    interface{} `json:"result,omitempty"`
}

// IsSuccess returns true if the response indicates success.
func (r *ResponseMessage) IsSuccess() bool {
	return r.Code == 0
}

// ConnectMessage represents authentication message between client and gateway.
type ConnectMessage struct {
	Type    string `json:"type"`
	RobotID string `json:"robotId,omitempty"`
	Secret  string `json:"secret,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Msg     string `json:"msg,omitempty"`
}

// NewConnectRequest creates a new connection request.
func NewConnectRequest(robotID, secret string) *ConnectMessage {
	return &ConnectMessage{
		Type:    "connect",
		RobotID: robotID,
		Secret:  secret,
	}
}

// NewConnectResponse creates a new connection response.
func NewConnectResponse(code int, msg string) *ConnectMessage {
	return &ConnectMessage{
		Type: "connect",
		Code: &code,
		Msg:  msg,
	}
}

// IsSuccess returns true if the connection was successful.
func (c *ConnectMessage) IsSuccess() bool {
	return c.Code != nil && *c.Code == 0
}

// PushMessage represents a push message from gateway to client.
type PushMessage struct {
	Type  string          `json:"type"`
	Data  *OutputMessageData `json:"data,omitempty"`
	Event string          `json:"event,omitempty"`
	Extra interface{}     `json:"extra,omitempty"`
}

// OutputMessageData represents the message data in a push message.
type OutputMessageData struct {
	Sender       string             `json:"sender"`
	Conv         *Conversation      `json:"conv"`
	Payload      *MessagePayload    `json:"payload"`
	FromUser     string             `json:"fromUser"`
	Timestamp    int64              `json:"timestamp"`
	MessageID    int64              `json:"messageId"`
	MessageUID   int64              `json:"messageUid"`
}

// Conversation represents a conversation (chat, group, etc.).
type Conversation struct {
	Type   int    `json:"type"`   // 0=single chat, 1=group, 2=super group
	Target string `json:"target"` // userId or groupId
	Line   int    `json:"line"`   // channel line
}

// MessagePayload represents the payload of a message.
type MessagePayload struct {
	Type              int    `json:"type"`              // 1=text, 2=voice, 3=image, 4=video, etc.
	SearchableContent string `json:"searchableContent"` // text content for searching
	PushContent       string `json:"pushContent"`       // push notification content
	Content           string `json:"content"`           // raw content
	Data              string `json:"data"`              // binary data (base64)
	RemoteMediaURL    string `json:"remoteMediaUrl"`    // media URL
	ExpireDuration    int    `json:"expireDuration"`    // message expiration
	MentionedType     int    `json:"mentionedType"`     // @ mention type
	MentionedTargets  []string `json:"mentionedTargets"` // @ mentioned users
	Extra             string `json:"extra"`             // extra data (JSON)
}
