.PHONY: all build clean test run-sdk run-adapter build-linux build-linux-amd64 build-linux-arm64

# Default target
all: build

# Build all
build: build-sdk build-adapter

# Build SDK example
build-sdk:
	cd sdk && go build -o ../bin/sdk-example ./example/main.go

# Build adapter
build-adapter:
	cd openclaw-adapter && go build -o ../bin/openclaw-adapter ./cmd/main.go

# ========================================
# Linux Cross Compilation
# ========================================

# Build all for Linux
build-linux: build-linux-amd64 build-linux-arm64

# Build for Linux AMD64 (x86_64)
build-linux-amd64:
	@echo "Building for Linux AMD64..."
	cd sdk && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../bin/sdk-example-linux-amd64 ./example/main.go
	cd openclaw-adapter && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../bin/openclaw-adapter-linux-amd64 ./cmd/main.go
	@echo "Linux AMD64 build complete: bin/sdk-example-linux-amd64, bin/openclaw-adapter-linux-amd64"

# Build for Linux ARM64 (aarch64, for ARM servers like AWS Graviton)
build-linux-arm64:
	@echo "Building for Linux ARM64..."
	cd sdk && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../bin/sdk-example-linux-arm64 ./example/main.go
	cd openclaw-adapter && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../bin/openclaw-adapter-linux-arm64 ./cmd/main.go
	@echo "Linux ARM64 build complete: bin/sdk-example-linux-arm64, bin/openclaw-adapter-linux-arm64"

# Run SDK example
run-sdk: build-sdk
	./bin/sdk-example $(ARGS)

# Run adapter
run-adapter: build-adapter
	./bin/openclaw-adapter

# Test
 test:
	cd sdk && go test ./...
	cd openclaw-adapter && go test ./...

# Clean
 clean:
	rm -rf bin/

# Download dependencies
deps:
	cd sdk && go mod tidy
	cd openclaw-adapter && go mod tidy

# Install tools
tools:
	go install golang.org/x/tools/cmd/goimports@latest

# Format code
fmt:
	cd sdk && gofmt -w .
	cd openclaw-adapter && gofmt -w .

# Lint
lint:
	cd sdk && go vet ./...
	cd openclaw-adapter && go vet ./...

# Help
help:
	@echo "Available targets:"
	@echo "  make build                 - Build SDK example and adapter (current platform)"
	@echo "  make build-sdk             - Build SDK example only"
	@echo "  make build-adapter         - Build adapter only"
	@echo "  make build-linux           - Build all for Linux (AMD64 + ARM64)"
	@echo "  make build-linux-amd64     - Build for Linux AMD64 (x86_64)"
	@echo "  make build-linux-arm64     - Build for Linux ARM64 (aarch64)"
	@echo "  make run-sdk ARGS=\"ws://localhost:8884 robotId secret\" - Run SDK example"
	@echo "  make run-adapter           - Run adapter"
	@echo "  make test                  - Run tests"
	@echo "  make clean                 - Clean build artifacts"
	@echo "  make deps                  - Download dependencies"
	@echo "  make fmt                   - Format code"
	@echo "  make lint                  - Run linter"
