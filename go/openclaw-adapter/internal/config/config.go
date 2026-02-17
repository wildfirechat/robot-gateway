package config

import (
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all configuration for the adapter.
type Config struct {
	Wildfire  WildfireConfig  `mapstructure:"wildfire"`
	Openclaw  OpenclawConfig  `mapstructure:"openclaw"`
	Group     GroupConfig     `mapstructure:"group"`
	Session   SessionConfig   `mapstructure:"session"`
	Whitelist WhitelistConfig `mapstructure:"whitelist"`
	Logging   LoggingConfig   `mapstructure:"logging"`
}

// WildfireConfig holds Wildfire IM gateway configuration.
type WildfireConfig struct {
	GatewayURL       string        `mapstructure:"gateway_url"`
	RobotID          string        `mapstructure:"robot_id"`
	RobotSecret      string        `mapstructure:"robot_secret"`
	ReconnectInterval time.Duration `mapstructure:"reconnect_interval"`
}

// OpenclawConfig holds Openclaw Gateway configuration.
type OpenclawConfig struct {
	URL               string        `mapstructure:"url"`
	Token             string        `mapstructure:"token"`
	Scope             string        `mapstructure:"scope"`
	ReconnectInterval time.Duration `mapstructure:"reconnect_interval"`
	HeartbeatInterval time.Duration `mapstructure:"heartbeat_interval"`
}

// GroupConfig holds group chat strategy configuration.
type GroupConfig struct {
	Enabled           bool     `mapstructure:"enabled"`
	AllowedIDs        []string `mapstructure:"allowed_ids"`
	RespondOnMention  bool     `mapstructure:"respond_on_mention"`
	RespondOnQuestion bool     `mapstructure:"respond_on_question"`
	HelpKeywords      []string `mapstructure:"help_keywords"`
}

// SessionConfig holds session management configuration.
type SessionConfig struct {
	Timeout     time.Duration `mapstructure:"timeout"`
	MaxSessions int           `mapstructure:"max_sessions"`
}

// WhitelistConfig holds whitelist filter configuration.
type WhitelistConfig struct {
	Enabled        bool     `mapstructure:"enabled"`
	AllowedSenders []string `mapstructure:"allowed_senders"`
	AllowedGroups  []string `mapstructure:"allowed_groups"`
	BlockedSenders []string `mapstructure:"blocked_senders"`
	BlockedGroups  []string `mapstructure:"blocked_groups"`
}

// LoggingConfig holds logging configuration.
type LoggingConfig struct {
	Level  string `mapstructure:"level"`
	Format string `mapstructure:"format"`
}

// Load loads configuration from file and environment.
func Load() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.AddConfigPath("./config")
	viper.AddConfigPath("/etc/openclaw-adapter/")

	// Set defaults
	setDefaults()

	// Read from environment variables
	viper.SetEnvPrefix("ADAPTER")
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	// Read config file
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, err
		}
		// Config file not found; use defaults and environment
	}

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

func setDefaults() {
	// Wildfire defaults
	viper.SetDefault("wildfire.gateway_url", "ws://localhost:8884/robot/gateway")
	viper.SetDefault("wildfire.reconnect_interval", "5s")

	// Openclaw defaults
	viper.SetDefault("openclaw.url", "ws://127.0.0.1:18789")
	viper.SetDefault("openclaw.scope", "wildfire-im")
	viper.SetDefault("openclaw.reconnect_interval", "5s")
	viper.SetDefault("openclaw.heartbeat_interval", "30s")

	// Group defaults
	viper.SetDefault("group.enabled", true)
	viper.SetDefault("group.respond_on_mention", true)
	viper.SetDefault("group.respond_on_question", true)
	viper.SetDefault("group.help_keywords", []string{"帮", "请", "分析", "总结", "怎么", "如何"})

	// Session defaults
	viper.SetDefault("session.timeout", "30m")
	viper.SetDefault("session.max_sessions", 1000)

	// Whitelist defaults
	viper.SetDefault("whitelist.enabled", false)

	// Logging defaults
	viper.SetDefault("logging.level", "info")
	viper.SetDefault("logging.format", "console")
}
