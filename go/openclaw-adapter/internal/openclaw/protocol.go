package openclaw

// OpenclawOutMessage represents a message sent to Openclaw Gateway.
type OpenclawOutMessage struct {
	Type    string              `json:"type"`
	Channel *OpenclawChannel    `json:"channel"`
	Message *OpenclawMessage    `json:"message"`
	Session *OpenclawSession    `json:"session,omitempty"`
}

// OpenclawChannel represents channel information.
type OpenclawChannel struct {
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
	PeerID   string `json:"peerId"`
	PeerName string `json:"peerName,omitempty"`
	IsGroup  bool   `json:"isGroup"`
}

// OpenclawMessage represents message content.
type OpenclawMessage struct {
	ID        int64               `json:"id,omitempty"`
	Text      string              `json:"text"`
	Timestamp int64               `json:"timestamp"`
	Mentions  []OpenclawMention   `json:"mentions,omitempty"`
	MediaURL  string              `json:"mediaUrl,omitempty"`
	MediaType string              `json:"mediaType,omitempty"`
	Extra     map[string]interface{} `json:"extra,omitempty"`
}

// SetExtra sets an extra field in the message.
func (m *OpenclawMessage) SetExtra(key string, value interface{}) {
	if m.Extra == nil {
		m.Extra = make(map[string]interface{})
	}
	m.Extra[key] = value
}

// GetExtra gets an extra field from the message.
func (m *OpenclawMessage) GetExtra(key string) interface{} {
	if m.Extra == nil {
		return nil
	}
	return m.Extra[key]
}

// OpenclawMention represents a mention in a message.
type OpenclawMention struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// OpenclawSession represents session information.
type OpenclawSession struct {
	ID string `json:"id"`
}

// OpenclawInMessage represents a message received from Openclaw Gateway.
type OpenclawInMessage struct {
	Type    string              `json:"type"`
	Channel *OpenclawChannel    `json:"channel,omitempty"`
	Message *OpenclawMessage    `json:"message,omitempty"`
	Meta    *OpenclawMeta       `json:"meta,omitempty"`
	Error   string              `json:"error,omitempty"`
}

// OpenclawMeta represents metadata in a message.
type OpenclawMeta struct {
	Streaming bool `json:"streaming,omitempty"`
}

// OpenClawProtocol represents the OpenClaw protocol structures.
type OpenClawProtocol struct{}

// RequestMessage represents a request to Openclaw.
type RequestMessage struct {
	Type   string      `json:"type"`
	ID     string      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

// ConnectParams represents connect request parameters.
type ConnectParams struct {
	MinProtocol int         `json:"minProtocol"`
	MaxProtocol int         `json:"maxProtocol"`
	Client      *ClientInfo `json:"client"`
	Role        string      `json:"role"`
	Scopes      []string    `json:"scopes"`
	Auth        *AuthInfo   `json:"auth,omitempty"`
	UserAgent   string      `json:"userAgent"`
}

// ClientInfo represents client information.
type ClientInfo struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Mode     string `json:"mode"`
}

// AuthInfo represents authentication information.
// Note: Only token field is sent, matching Openclaw server expectations.
type AuthInfo struct {
	Token string `json:"token"`
}

// ChatSendParams represents chat.send parameters.
type ChatSendParams struct {
	SessionKey     string       `json:"sessionKey"`
	Message        string       `json:"message"`
	IdempotencyKey string       `json:"idempotencyKey"`
	Attachments    []Attachment `json:"attachments,omitempty"`
}

// Attachment represents a message attachment.
type Attachment struct {
	Type string `json:"type"`
	URL  string `json:"url"`
	Name string `json:"name,omitempty"`
}

// ResponseMessage represents a response from Openclaw Gateway.
type ResponseMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Ok      bool            `json:"ok"`
	Payload *ResponsePayload `json:"payload,omitempty"`
	Error   interface{}     `json:"error,omitempty"`
}

// ResponsePayload represents the payload in a response.
type ResponsePayload struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	Policy   *Policy `json:"policy,omitempty"`
	RunID    string `json:"runId,omitempty"`
}

// Policy represents policy information in a response.
type Policy struct {
	TickIntervalMs int `json:"tickIntervalMs"`
}
