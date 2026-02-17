package filter

import (
	"strings"

	"github.com/wildfirechat/openclaw-adapter/internal/config"
	"github.com/wildfirechat/openclaw-adapter/internal/openclaw"
	"go.uber.org/zap"
)

// GroupFilter filters group chat messages based on strategy.
type GroupFilter struct {
	config *config.GroupConfig
	logger *zap.Logger
}

// NewGroupFilter creates a new GroupFilter.
func NewGroupFilter(cfg *config.GroupConfig, logger *zap.Logger) *GroupFilter {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &GroupFilter{
		config: cfg,
		logger: logger,
	}
}

// ShouldRespond determines if the adapter should respond to a group message.
func (f *GroupFilter) ShouldRespond(msg *openclaw.OpenclawOutMessage, botID string) bool {
	if msg == nil || msg.Channel == nil {
		return false
	}

	// Only filter group messages
	if !msg.Channel.IsGroup {
		return true
	}

	if !f.config.Enabled {
		f.logger.Debug("Group filter disabled, allowing message")
		return true
	}

	// Check allowed group IDs
	if len(f.config.AllowedIDs) > 0 {
		allowed := false
		for _, id := range f.config.AllowedIDs {
			if id == msg.Channel.ThreadID {
				allowed = true
				break
			}
		}
		if !allowed {
			f.logger.Debug("Group not in allowed list",
				zap.String("groupId", msg.Channel.ThreadID))
			return false
		}
	}

	text := ""
	if msg.Message != nil {
		text = msg.Message.Text
	}

	// Strategy 1: Check if bot is mentioned
	if f.config.RespondOnMention && botID != "" {
		if f.containsMention(msg, botID) {
			f.logger.Debug("Responding because bot was mentioned")
			return true
		}
	}

	// Strategy 2: Check if message ends with question mark
	if f.config.RespondOnQuestion {
		if strings.HasSuffix(text, "?") || strings.HasSuffix(text, "？") {
			f.logger.Debug("Responding because message ends with question")
			return true
		}
	}

	// Strategy 3: Check for help keywords
	for _, keyword := range f.config.HelpKeywords {
		if strings.Contains(text, keyword) {
			f.logger.Debug("Responding because of help keyword",
				zap.String("keyword", keyword))
			return true
		}
	}

	f.logger.Debug("Message blocked by group filter")
	return false
}

// containsMention checks if the bot is mentioned in the message.
func (f *GroupFilter) containsMention(msg *openclaw.OpenclawOutMessage, botID string) bool {
	if msg.Message == nil {
		return false
	}

	// Check explicit mentions
	for _, mention := range msg.Message.Mentions {
		if mention.ID == botID {
			return true
		}
	}

	// Check if bot ID is in the text
	if strings.Contains(msg.Message.Text, "@"+botID) {
		return true
	}

	return false
}
