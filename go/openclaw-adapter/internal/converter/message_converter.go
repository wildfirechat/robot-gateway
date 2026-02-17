package converter

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wildfirechat/openclaw-adapter/internal/openclaw"
	"github.com/wildfirechat/robot-gateway-sdk/protocol"
	"go.uber.org/zap"
)

// MessageConverter converts messages between Wildfire and Openclaw formats.
type MessageConverter struct {
	logger *zap.Logger
}

// WildfireSendMessage represents a message to be sent to Wildfire.
type WildfireSendMessage struct {
	Conversation *protocol.Conversation
	Payload      *protocol.MessagePayload
	TargetUserID string
	IsGroup      bool
	Text         string
	StreamID     string
	StreamState  string
}

// NewMessageConverter creates a new MessageConverter.
func NewMessageConverter(logger *zap.Logger) *MessageConverter {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &MessageConverter{logger: logger}
}

// ConvertToOpenclaw converts a Wildfire message to Openclaw format.
func (c *MessageConverter) ConvertToOpenclaw(wildfireMsg *protocol.PushMessage) *openclaw.OpenclawOutMessage {
	if wildfireMsg == nil || wildfireMsg.Data == nil {
		c.logger.Debug("Empty message data")
		return nil
	}

	data := wildfireMsg.Data

	// Extract text content
	text := c.extractTextContent(data)
	if text == "" {
		c.logger.Debug("Unknown or unsupported message type",
			zap.Int("type", data.Payload.Type))
		return nil
	}

	// Determine conversation type
	isGroup := data.Conv != nil && (data.Conv.Type == 1 || data.Conv.Type == 2)

	// Build channel
	channel := &openclaw.OpenclawChannel{
		ID:       "wildfire-im",
		PeerID:   data.Sender,
		PeerName: data.Sender,
		IsGroup:  isGroup,
	}

	if data.Conv != nil {
		if data.Conv.Type == 0 {
			// Private chat
			channel.ThreadID = data.Sender
		} else {
			// Group chat
			channel.ThreadID = data.Conv.Target
		}
	}

	// Build message
	message := &openclaw.OpenclawMessage{
		Text:      text,
		Timestamp: data.Timestamp,
	}

	// Extract media info
	mediaURL, mediaType := c.extractMediaInfo(data)
	if mediaURL != "" {
		message.MediaURL = mediaURL
		message.MediaType = mediaType
	}

	// Build session
	session := &openclaw.OpenclawSession{
		ID: c.generateSessionID(channel.ThreadID, data.Sender),
	}

	return &openclaw.OpenclawOutMessage{
		Type:    "message",
		Channel: channel,
		Message: message,
		Session: session,
	}
}

// ConvertFromOpenclaw converts an Openclaw message to Wildfire format.
func (c *MessageConverter) ConvertFromOpenclaw(openclawMsg *openclaw.OpenclawInMessage) *WildfireSendMessage {
	if openclawMsg == nil || openclawMsg.Channel == nil {
		c.logger.Debug("Invalid Openclaw message")
		return nil
	}

	channel := openclawMsg.Channel
	message := openclawMsg.Message

	if message == nil {
		message = &openclaw.OpenclawMessage{}
	}

	// Determine if group chat
	isGroup := channel.ThreadID != "" && channel.PeerID != "" && channel.ThreadID != channel.PeerID

	// Build conversation
	conv := &protocol.Conversation{
		Type:   0, // Single chat
		Target: channel.ThreadID,
		Line:   0,
	}

	if isGroup {
		conv.Type = 1 // Group chat
	}

	if conv.Target == "" {
		conv.Target = channel.PeerID
	}

	// Handle streaming states
	var streamID, streamState string
	if message.Extra != nil {
		if sid, ok := message.Extra["streamId"].(string); ok {
			streamID = sid
		}
		if state, ok := message.Extra["state"].(string); ok {
			streamState = state
		}
	}

	// Build payload based on stream state
	payload := c.buildPayload(message.Text, streamID, streamState)

	return &WildfireSendMessage{
		Conversation: conv,
		Payload:      payload,
		TargetUserID: channel.PeerID,
		IsGroup:      isGroup,
		Text:         message.Text,
		StreamID:     streamID,
		StreamState:  streamState,
	}
}

// buildPayload builds MessagePayload based on stream state.
// For streaming messages, uses special content types to show typing indicators.
func (c *MessageConverter) buildPayload(text, streamID, streamState string) *protocol.MessagePayload {
	// StreamTextGeneratingMessageContent type = 14
	// StreamTextGeneratedMessageContent type = 15
	// encode() sets: searchableContent=text, content=streamId

	if streamID != "" && (streamState == "generating" || streamState == "start") {
		// Streaming in progress - use generating type
		return &protocol.MessagePayload{
			Type:              14, // StreamTextGeneratingMessageContent
			SearchableContent: text,
			Content:           streamID, // content field stores streamId
		}
	} else if streamID != "" && streamState == "completed" {
		// Streaming completed - use generated type
		return &protocol.MessagePayload{
			Type:              15, // StreamTextGeneratedMessageContent
			SearchableContent: text,
			Content:           streamID, // content field stores streamId
		}
	}

	// Regular text message
	return &protocol.MessagePayload{
		Type:              1, // Text message
		SearchableContent: text,
	}
}

// extractTextContent extracts text content from message payload.
func (c *MessageConverter) extractTextContent(data *protocol.OutputMessageData) string {
	if data.Payload == nil {
		return ""
	}

	payload := data.Payload
	msgType := payload.Type

	switch msgType {
	case 1: // Text message
		return payload.SearchableContent

	case 2: // Voice message
		voiceURL := c.extractMediaURL(payload)
		duration := c.getIntFromExtra(payload.Extra, "duration", 0)
		return fmt.Sprintf("[语音消息] 时长:%d秒 URL:%s", duration, voiceURL)

	case 3: // Image message
		imageURL := c.extractMediaURL(payload)
		desc := payload.SearchableContent
		if desc == "" {
			desc = "图片"
		}
		return fmt.Sprintf("[图片消息] %s URL:%s", desc, imageURL)

	case 4: // Video message
		videoURL := c.extractMediaURL(payload)
		extraJSON := c.parseExtraJSON(payload.Extra)
		duration := c.getIntFromExtraObj(extraJSON, "duration", 0)
		hasThumbnail := "无缩略图"
		if c.hasExtraField(extraJSON, "thumbnail") {
			hasThumbnail = "有缩略图"
		}
		return fmt.Sprintf("[视频消息] 时长:%d秒 %s URL:%s", duration, hasThumbnail, videoURL)

	case 5: // File message
		fileURL := c.extractMediaURL(payload)
		fileName := payload.SearchableContent
		extraJSON := c.parseExtraJSON(payload.Extra)
		fileSize := c.getInt64FromExtraObj(extraJSON, "size", 0)
		if fileName == "" {
			fileName = "未知文件"
		}
		return fmt.Sprintf("[文件消息] %s 大小:%s URL:%s", fileName, c.formatFileSize(fileSize), fileURL)

	default:
		c.logger.Debug("Unknown message type", zap.Int("type", msgType))
		return fmt.Sprintf("[消息类型:%d] %s", msgType, payload.SearchableContent)
	}
}

// extractMediaInfo extracts media URL and type from message.
func (c *MessageConverter) extractMediaInfo(data *protocol.OutputMessageData) (string, string) {
	if data.Payload == nil {
		return "", ""
	}

	payload := data.Payload
	msgType := payload.Type
	mediaURL := c.extractMediaURL(payload)

	if mediaURL == "" {
		return "", ""
	}

	switch msgType {
	case 2:
		return mediaURL, "audio"
	case 3:
		return mediaURL, "image"
	case 4:
		return mediaURL, "video"
	case 5:
		return mediaURL, "file"
	default:
		return "", ""
	}
}

// extractMediaURL extracts media URL from payload.
func (c *MessageConverter) extractMediaURL(payload *protocol.MessagePayload) string {
	// Try remoteMediaUrl first
	if payload.RemoteMediaURL != "" {
		return payload.RemoteMediaURL
	}

	// Try extra JSON
	extraJSON := c.parseExtraJSON(payload.Extra)
	if extraJSON != nil {
		if url, ok := extraJSON["url"].(string); ok {
			return url
		}
	}

	// Try extra as raw URL
	if payload.Extra != "" && (strings.HasPrefix(payload.Extra, "http://") || strings.HasPrefix(payload.Extra, "https://")) {
		return payload.Extra
	}

	return ""
}

// parseExtraJSON parses extra field as JSON.
func (c *MessageConverter) parseExtraJSON(extra string) map[string]interface{} {
	if extra == "" {
		return nil
	}

	var result map[string]interface{}
	if err := json.Unmarshal([]byte(extra), &result); err != nil {
		return nil
	}
	return result
}

// getIntFromExtra extracts int value from extra JSON string.
func (c *MessageConverter) getIntFromExtra(extra, field string, defaultVal int) int {
	extraJSON := c.parseExtraJSON(extra)
	return c.getIntFromExtraObj(extraJSON, field, defaultVal)
}

// getIntFromExtraObj extracts int value from extra JSON object.
func (c *MessageConverter) getIntFromExtraObj(extraJSON map[string]interface{}, field string, defaultVal int) int {
	if extraJSON == nil {
		return defaultVal
	}

	val, ok := extraJSON[field]
	if !ok {
		return defaultVal
	}

	switch v := val.(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return defaultVal
	}
}

// getInt64FromExtraObj extracts int64 value from extra JSON object.
func (c *MessageConverter) getInt64FromExtraObj(extraJSON map[string]interface{}, field string, defaultVal int64) int64 {
	if extraJSON == nil {
		return defaultVal
	}

	val, ok := extraJSON[field]
	if !ok {
		return defaultVal
	}

	switch v := val.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	default:
		return defaultVal
	}
}

// hasExtraField checks if extra JSON has a field.
func (c *MessageConverter) hasExtraField(extraJSON map[string]interface{}, field string) bool {
	if extraJSON == nil {
		return false
	}
	_, ok := extraJSON[field]
	return ok
}

// formatFileSize formats file size to human readable string.
func (c *MessageConverter) formatFileSize(size int64) string {
	if size <= 0 {
		return "未知"
	}
	if size < 1024 {
		return fmt.Sprintf("%dB", size)
	}
	if size < 1024*1024 {
		return fmt.Sprintf("%.2fKB", float64(size)/1024)
	}
	if size < 1024*1024*1024 {
		return fmt.Sprintf("%.2fMB", float64(size)/(1024*1024))
	}
	return fmt.Sprintf("%.2fGB", float64(size)/(1024*1024*1024))
}

// generateSessionID generates a session ID.
func (c *MessageConverter) generateSessionID(threadID, peerID string) string {
	return fmt.Sprintf("%s:%s", threadID, peerID)
}
