package filter

import (
	"github.com/wildfirechat/openclaw-adapter/internal/config"
	"go.uber.org/zap"
)

// WhitelistFilter filters messages based on whitelist/blacklist.
type WhitelistFilter struct {
	config *config.WhitelistConfig
	logger *zap.Logger
}

// NewWhitelistFilter creates a new WhitelistFilter.
func NewWhitelistFilter(cfg *config.WhitelistConfig, logger *zap.Logger) *WhitelistFilter {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &WhitelistFilter{
		config: cfg,
		logger: logger,
	}
}

// ShouldProcess determines if a message should be processed.
func (f *WhitelistFilter) ShouldProcess(senderID, targetID string, isGroup bool) bool {
	if !f.config.Enabled {
		return true
	}

	// Check blocked senders
	for _, blocked := range f.config.BlockedSenders {
		if blocked == senderID {
			f.logger.Debug("Sender blocked", zap.String("senderId", senderID))
			return false
		}
	}

	// Check blocked groups
	if isGroup {
		for _, blocked := range f.config.BlockedGroups {
			if blocked == targetID {
				f.logger.Debug("Group blocked", zap.String("groupId", targetID))
				return false
			}
		}
	}

	// If allowed lists are empty, allow all (except blocked)
	if len(f.config.AllowedSenders) == 0 && len(f.config.AllowedGroups) == 0 {
		return true
	}

	// Check allowed senders
	senderAllowed := len(f.config.AllowedSenders) == 0
	for _, allowed := range f.config.AllowedSenders {
		if allowed == senderID {
			senderAllowed = true
			break
		}
	}

	if !senderAllowed {
		f.logger.Debug("Sender not in allowed list", zap.String("senderId", senderID))
		return false
	}

	// Check allowed groups
	if isGroup {
		groupAllowed := len(f.config.AllowedGroups) == 0
		for _, allowed := range f.config.AllowedGroups {
			if allowed == targetID {
				groupAllowed = true
				break
			}
		}

		if !groupAllowed {
			f.logger.Debug("Group not in allowed list", zap.String("groupId", targetID))
			return false
		}
	}

	return true
}
