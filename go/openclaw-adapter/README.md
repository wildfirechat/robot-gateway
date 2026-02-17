# OpenClaw Adapter (Go)

将野火IM与OpenClaw Gateway连接的适配器，实现AI对话功能。

## 功能特性

- 双向消息转发（野火IM ↔ OpenClaw）
- 消息格式自动转换
- 群聊防刷屏策略
- 会话上下文管理
- 自动重连
- 流式消息支持
- 白名单过滤
- HTTP健康检查

## 快速开始

### 1. 配置

复制示例配置文件：

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`：

```yaml
wildfire:
  gateway_url: "ws://localhost:8884/robot/gateway"
  robot_id: "YourRobotId"
  robot_secret: "YourRobotSecret"

openclaw:
  url: "ws://127.0.0.1:18789"
  token: "your-token-if-needed"
```

### 2. 运行

```bash
# 使用默认配置
go run cmd/main.go

# 使用指定配置文件
go run cmd/main.go --config /path/to/config.yaml

# 或使用环境变量
export ADAPTER_WILDFIRE_ROBOT_ID=YourRobotId
export ADAPTER_WILDFIRE_ROBOT_SECRET=YourRobotSecret
go run cmd/main.go
```

### 3. 构建

```bash
# 构建二进制文件
go build -o openclaw-adapter cmd/main.go

# 运行
./openclaw-adapter
```

## 配置详解

### 野火网关配置

```yaml
wildfire:
  gateway_url: "ws://localhost:8884/robot/gateway"  # 野火网关WebSocket地址
  robot_id: "YourRobotId"                           # 机器人ID
  robot_secret: "YourRobotSecret"                   # 机器人密钥
  reconnect_interval: "5s"                          # 重连间隔
```

### OpenClaw网关配置

```yaml
openclaw:
  url: "ws://127.0.0.1:18789"      # OpenClaw Gateway地址
  token: ""                         # 认证令牌（可选）
  scope: "wildfire-im"              # 作用域
  reconnect_interval: "5s"          # 重连间隔
  heartbeat_interval: "30s"         # 心跳间隔
```

### 群聊策略配置

```yaml
group:
  enabled: true                     # 是否启用群聊过滤
  allowed_ids: []                   # 允许的群ID列表（为空表示全部）
  respond_on_mention: true          # 被@时回复
  respond_on_question: true         # 问号结尾时回复
  help_keywords:                    # 触发回复的关键词
    - "帮"
    - "请"
    - "分析"
    - "总结"
    - "怎么"
    - "如何"
```

群聊防刷屏策略说明：
1. **被@时回复**：消息中@机器人时自动回复
2. **问号结尾**：消息以"?"或"？"结尾时回复
3. **关键词匹配**：消息包含特定关键词时回复
4. **白名单群聊**：只在指定群聊中回复

### 白名单配置

```yaml
whitelist:
  enabled: false                    # 是否启用白名单
  allowed_senders: []               # 允许的发送者ID
  allowed_groups: []                # 允许的群ID
  blocked_senders: []               # 屏蔽的发送者ID
  blocked_groups: []                # 屏蔽的群ID
```

### 会话配置

```yaml
session:
  timeout: "30m"                    # 会话超时时间
  max_sessions: 1000                # 最大会话数
```

## API 端点

### 健康检查

```bash
curl http://localhost:8080/health
```

响应：
```json
{
  "status": "UP",
  "components": {
    "wildfire": {
      "connected": true,
      "authenticated": true
    },
    "openclaw": {
      "connected": true,
      "authenticated": true
    }
  }
}
```

### 会话统计

```bash
curl http://localhost:8080/sessions
```

响应：
```json
{
  "totalSessions": 150,
  "privateSessions": 120,
  "groupSessions": 30
}
```

### 状态页面

```bash
curl http://localhost:8080/
```

## 部署

### 使用 systemd

创建服务文件 `/etc/systemd/system/openclaw-adapter.service`：

```ini
[Unit]
Description=OpenClaw Adapter
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/opt/openclaw-adapter
ExecStart=/opt/openclaw-adapter/openclaw-adapter
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable openclaw-adapter
sudo systemctl start openclaw-adapter
sudo systemctl status openclaw-adapter
```

### Docker 部署

```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o openclaw-adapter cmd/main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/openclaw-adapter .
COPY config.yaml .
CMD ["./openclaw-adapter"]
```

## 日志级别

通过环境变量设置日志级别：

```bash
export LOG_LEVEL=debug  # debug, info, warn, error
```

## 故障排查

### 连接失败

1. 检查野火网关地址是否正确
2. 检查机器人ID和密钥是否正确
3. 检查网络连通性

### 群聊不回复

1. 检查群聊策略配置是否启用
2. 检查是否被@或包含关键词
3. 查看日志中的过滤记录

### OpenClaw无响应

1. 检查OpenClaw Gateway是否运行
2. 检查网络连接
3. 验证token配置

## 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                       野火IM系统                              │
│           用户发送消息 → 野火网关(:8884)                       │
└───────────────────────────┬─────────────────────────────────┘
                            │ WebSocket
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              OpenClaw Adapter (Go版本)                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 1. WildfireClient - 连接野火网关                        │  │
│  │ 2. OpenclawWebSocketClient - 连接OpenClaw Gateway      │  │
│  │ 3. MessageConverter - 双向消息格式转换                  │  │
│  │ 4. GroupFilter - 群聊防刷屏策略                         │  │
│  │ 5. SessionContextManager - 会话管理                    │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            │ WebSocket
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              OpenClaw Gateway (ws://127.0.0.1:18789)         │
└─────────────────────────────────────────────────────────────┘
```
