package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/wildfirechat/openclaw-adapter/internal/bridge"
	"github.com/wildfirechat/openclaw-adapter/internal/config"
	"github.com/wildfirechat/openclaw-adapter/internal/session"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func main() {
	// Load configuration first
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load configuration: %v\n", err)
		os.Exit(1)
	}

	// Initialize logger with config
	logger := initLogger(cfg.Logging)
	defer logger.Sync()

	logger.Info("Configuration loaded",
		zap.String("wildfire_gateway", cfg.Wildfire.GatewayURL),
		zap.String("openclaw_gateway", cfg.Openclaw.URL))

	// Create bridge
	b := bridge.NewBridge(cfg, logger)

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start bridge
	if err := b.Start(ctx); err != nil {
		logger.Fatal("Failed to start bridge", zap.Error(err))
	}

	// Start HTTP server for health checks
	httpServer := startHTTPServer(b, cfg, logger)

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	logger.Info("Adapter started. Press Ctrl+C to stop.")

	select {
	case sig := <-sigChan:
		logger.Info("Received signal, shutting down", zap.String("signal", sig.String()))
	case <-ctx.Done():
		logger.Info("Context cancelled, shutting down")
	}

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", zap.Error(err))
	}

	b.Stop()

	logger.Info("Adapter stopped")
}

func startHTTPServer(b *bridge.Bridge, cfg *config.Config, logger *zap.Logger) *http.Server {
	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		status := map[string]interface{}{
			"status": "UP",
			"components": map[string]interface{}{
				"wildfire": map[string]interface{}{
					"status":        b.IsWildfireConnected(),
					"connected":     b.IsWildfireConnected(),
					"authenticated": b.IsWildfireConnected(),
				},
				"openclaw": map[string]interface{}{
					"status":        b.IsOpenclawConnected(),
					"connected":     b.IsOpenclawConnected(),
					"authenticated": b.IsOpenclawConnected(),
				},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		if !b.IsWildfireConnected() || !b.IsOpenclawConnected() {
			w.WriteHeader(http.StatusServiceUnavailable)
		}

		fmt.Fprintf(w, `{"status":"%s","components":{"wildfire":{"connected":%v},"openclaw":{"connected":%v}}}`,
			status["status"],
			b.IsWildfireConnected(),
			b.IsOpenclawConnected(),
		)
	})

	// Session statistics endpoint
	mux.HandleFunc("/sessions", func(w http.ResponseWriter, r *http.Request) {
		sessionMgr := session.NewContextManager()
		total, private, group := sessionMgr.GetStats()

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"totalSessions":%d,"privateSessions":%d,"groupSessions":%d}`,
			total, private, group)
	})

	// Simple status endpoint
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "Openclaw Adapter\n")
		fmt.Fprintf(w, "================\n")
		fmt.Fprintf(w, "Wildfire Connected: %v\n", b.IsWildfireConnected())
		fmt.Fprintf(w, "Openclaw Connected: %v\n", b.IsOpenclawConnected())
	})

	server := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	go func() {
		logger.Info("HTTP server started", zap.String("addr", server.Addr))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server error", zap.Error(err))
		}
	}()

	return server
}

// initLogger initializes zap logger based on configuration.
func initLogger(cfg config.LoggingConfig) *zap.Logger {
	// Parse log level
	var level zapcore.Level
	switch strings.ToLower(cfg.Level) {
	case "debug":
		level = zapcore.DebugLevel
	case "info":
		level = zapcore.InfoLevel
	case "warn", "warning":
		level = zapcore.WarnLevel
	case "error":
		level = zapcore.ErrorLevel
	default:
		level = zapcore.InfoLevel
	}

	// Create encoder config based on format
	var encoderConfig zapcore.EncoderConfig
	var encoder zapcore.Encoder

	if cfg.Format == "json" {
		encoderConfig = zap.NewProductionEncoderConfig()
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoderConfig = zap.NewDevelopmentEncoderConfig()
		encoderConfig.EncodeTime = zapcore.TimeEncoderOfLayout("2006-01-02 15:04:05.000")
		encoderConfig.EncodeLevel = zapcore.CapitalLevelEncoder
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}

	// Create core
	core := zapcore.NewCore(
		encoder,
		zapcore.AddSync(os.Stdout),
		level,
	)

	// Create logger
	logger := zap.New(core, zap.AddCaller(), zap.AddStacktrace(zapcore.ErrorLevel))

	return logger
}
