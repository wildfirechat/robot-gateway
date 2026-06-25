# Hermes 野火 IM 平台适配器

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 平台插件，通过 [robot-gateway](https://github.com/wildfirechat/robot-gateway) WebSocket 协议将 Hermes 与[野火 IM](https://www.wildfirechat.cn/) 连接起来。

## 功能

- **双向消息桥接**：接收野火 IM 用户/群组消息，并将 Hermes 的回复发送回去。
- **自动重连**：通过固定间隔自动重连 `robot-gateway`（间隔可配置）。
- **群组过滤**：仅在群聊中被 @、消息以 `?`/`？` 结尾，或包含帮助关键词时才回复（可配置）。
- **媒体支持**：文本、图片、文件和视频消息（文件会先通过 `robot-gateway` 上传）。
- **流式回复**：支持 Hermes draft streaming，实时更新同一条消息气泡。
- **输入提示**：支持向对方发送“正在输入”状态提示。
- **会话隔离**：每个私聊用户和每个群组都有独立的 Hermes 会话。

## 架构

```
┌─────────────┐     WebSocket      ┌──────────────┐     HTTP/RobotService     ┌──────────┐
│  Hermes     │ ◀──robot-gateway──▶ │ robot-gateway │ ◀──────────────────────▶ │  野火 IM  │
│  Agent      │    协议             │ (ws :8884)    │                         └──────────┘
└─────────────┘                    └──────────────┘
```

## 安装

### 方式一：目录插件（开发推荐）

```bash
# 克隆本仓库
git clone https://github.com/your-org/hermes-wildfire.git

# 安装到 Hermes 插件目录（目录名可任意，这里使用和插件 manifest 一致的 wildfire-platform）
mkdir -p ~/.hermes/plugins
rsync -av --exclude='.venv' --exclude='.git' --exclude='*.egg-info' \
    hermes-wildfire/ ~/.hermes/plugins/wildfire-platform/

# 启用插件并重启 gateway
hermes plugins enable wildfire-platform
hermes gateway restart
```

或者一键运行仓库里的安装脚本：

```bash
bash scripts/install.sh
```

### 方式二：pip 包

```bash
pip install -e .
# Hermes 会通过 `hermes_agent.plugins` entry point 自动发现该插件
hermes gateway restart
```

## 配置

本插件的所有配置均通过**环境变量**读取，保持单一来源。推荐放在 `~/.hermes/.env` 中。

启用插件后，还需要配置机器人凭据。

### `plugins.enabled`

确保 `~/.hermes/config.yaml` 包含：

```yaml
plugins:
  enabled:
    - wildfire-platform
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `WILDFIRE_GATEWAY_URL` | 是 | `ws://host:8884/robot/gateway` |
| `WILDFIRE_ROBOT_ID` | 是 | 野火 IM 机器人 ID |
| `WILDFIRE_ROBOT_SECRET` | 是 | 野火 IM 机器人密钥 |
| `WILDFIRE_HOME_CHANNEL` | 否 | **唯一**配置 home channel 的地方；`user:userId` 或 `group:groupId`，用于 cron 结果投递和跨平台消息 |
| `WILDFIRE_REQUIRE_MENTION` | 否 | 群聊中是否需要 @ 或帮助关键词才回复，默认 `true` |
| `WILDFIRE_HELP_KEYWORDS` | 否 | 逗号分隔的帮助关键词，例如 `帮,请,分析,总结` |
| `WILDFIRE_ALLOWED_USERS` | 否 | 允许私聊机器人的用户 ID，逗号分隔 |
| `WILDFIRE_ALLOWED_GROUPS` | 否 | 允许机器人加入的群组 ID，逗号分隔 |
| `WILDFIRE_ALLOW_ALL_USERS` | 否 | 设为 `true` 时允许所有用户访问（开发环境使用，生产环境建议配置白名单） |
| `WILDFIRE_RECONNECT_INTERVAL` | 否 | 自动重连间隔（秒），默认 `5.0` |
| `WILDFIRE_RECONNECT_WAIT_TIMEOUT` | 否 | 发送超时后等待重连完成的最长时间（秒），默认 `2.0` |
| `WILDFIRE_REQUEST_TIMEOUT` | 否 | robot-gateway 请求超时时间（秒），默认 `30.0` |

### Home Channel

Home channel 用于投递 cron 任务结果和跨平台消息，通过 `.env` 文件配置：

```bash
# ~/.hermes/.env
WILDFIRE_HOME_CHANNEL=user:alice
# 或群聊
WILDFIRE_HOME_CHANNEL=group:groupId
```

> 注意：本插件不支持聊天里的 `/sethome` 命令。修改 `.env` 后需重启 gateway 生效。

## 使用

Gateway 启动后：

```bash
hermes gateway status
```

你应该能看到 **Wildfire IM** 已作为已连接平台列出。

在野火 IM 中搜索你的机器人 ID 并开始聊天：

- **私聊**：每条消息都会转发给 Hermes。
- **群聊**：机器人在以下情况才会回复：
  - 被 @，**或**
  - 消息以 `?` / `？` 结尾，**或**
  - 消息包含配置的帮助关键词之一。

## 开发

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## 许可证

MIT
