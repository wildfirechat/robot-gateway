# Openclaw Adapter 部署说明

## 配置文件

应用程序使用 YAML 格式的配置文件，默认查找以下位置的 `config.yaml`：

1. 当前目录 (`./`)
2. 配置目录 (`./config/`)
3. 系统配置目录 (`/etc/openclaw-adapter/`)

## 快速开始

1. 复制示例配置文件：
```bash
cp config.example.yaml config.yaml
```

2. 根据实际环境修改 `config.yaml` 中的配置项

3. 启动应用程序：
```bash
./openclaw-adapter
```

## 配置项说明

### Wildfire IM 网关配置

```yaml
wildfire:
  gateway_url: "ws://43.143.148.156:8884/robot/gateway"  # 野火网关地址
  robot_id: "your_robot_id"                               # 机器人ID
  robot_secret: "your_robot_secret"                       # 机器人密钥
  reconnect_interval: "5s"                                # 重连间隔
```

### Openclaw 网关配置

```yaml
openclaw:
  url: "ws://127.0.0.1:18789"                             # Openclaw网关地址
  token: "your_openclaw_token"                            # 访问令牌
  scope: "wildfire-im"                                    # 作用域标识
  reconnect_interval: "5s"                                # 重连间隔
  heartbeat_interval: "30s"                               # 心跳间隔
```

### 群组策略配置

```yaml
group:
  enabled: true                                           # 是否启用群组消息处理
  allowed_ids: []                                         # 允许处理的群组ID列表
  respond_on_mention: true                                # 被@时是否响应
  respond_on_question: true                               # 检测问题时是否响应
  help_keywords: ["帮", "请", "分析", "总结", "怎么", "如何"]  # 帮助关键词
```

### 会话管理配置

```yaml
session:
  timeout: "30m"                                          # 会话超时时间
  max_sessions: 1000                                      # 最大会话数
```

### 白名单配置

```yaml
whitelist:
  enabled: true                                           # 是否启用白名单
  allowed_senders:                                        # 允许的用户ID列表
    - "user_id_1"
  allowed_groups: []                                      # 允许的群组ID列表
  blocked_senders: []                                     # 阻止的用户ID列表
  blocked_groups: []                                      # 阻止的群组ID列表
```

### 日志配置

```yaml
logging:
  level: "debug"                                          # 日志级别: debug, info, warn, error
  format: "console"                                       # 输出格式: console, json
```

## 环境变量

所有配置项都支持通过环境变量设置，环境变量前缀为 `ADAPTER_`，使用下划线代替点号：

```bash
# 示例
export ADAPTER_WILDFIRE_GATEWAY_URL="ws://localhost:8884/robot/gateway"
export ADAPTER_WILDFIRE_ROBOT_ID="your_robot_id"
export ADAPTER_WILDFIRE_ROBOT_SECRET="your_robot_secret"
export ADAPTER_OPENCLAW_URL="ws://127.0.0.1:18789"
export ADAPTER_OPENCLAW_TOKEN="your_token"
export ADAPTER_LOGGING_LEVEL="info"
```

## 健康检查

应用程序启动后会监听 8080 端口提供健康检查端点：

- `GET /` - 简单状态页面
- `GET /health` - 健康检查接口（JSON格式）
- `GET /sessions` - 会话统计信息

## 与 Java 版本配置对照

| Java 配置项 | Go 配置项 | 说明 |
|------------|----------|------|
| `wildfire.gateway.url` | `wildfire.gateway_url` | 网关地址 |
| `wildfire.robot.id` | `wildfire.robot_id` | 机器人ID |
| `wildfire.robot.secret` | `wildfire.robot_secret` | 机器人密钥 |
| `openclaw.gateway.url` | `openclaw.url` | Openclaw地址 |
| `openclaw.gateway.token` | `openclaw.token` | 访问令牌 |
| `openclaw.whitelist.enabled` | `whitelist.enabled` | 白名单开关 |
| `openclaw.whitelist.allowed-users` | `whitelist.allowed_senders` | 允许的用户 |
| `openclaw.whitelist.allowed-groups` | `whitelist.allowed_groups` | 允许的群组 |
| `logging.level.root` | `logging.level` | 日志级别 |
