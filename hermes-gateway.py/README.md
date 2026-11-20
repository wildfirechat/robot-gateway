# Hermes 野火 IM 平台适配器

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 平台插件，通过 [robot-gateway](https://github.com/wildfirechat/robot-gateway) WebSocket 协议将 Hermes 与[野火 IM](https://www.wildfirechat.cn/) 连接起来。

## 功能

- **双向消息桥接**：接收野火 IM 用户/群组消息，并将 Hermes 的回复发送回去。
- **自动重连**：通过固定间隔自动重连 `robot-gateway`（间隔可配置）。
- **访问控制（fail-closed）**：私聊按 `WILDFIRE_ALLOWED_USERS` + 机器人 owner（或 `WILDFIRE_ALLOW_ALL_USERS`）；群聊按 `WILDFIRE_ALLOWED_GROUPS` + 可选群成员白名单；未配置白名单时默认拒绝（不会因为 `getProfile` 失败而放行所有人）。
- **群聊默认仅 @ 触发**：`?`/帮助关键词触发必须显式开启 `WILDFIRE_GROUP_KEYWORD_TRIGGERS`。
- **限流**：按发送者、按群组的滑动窗口限流（可配置，0 关闭）。
- **入站媒体安全下载**：消息里的 `mediaUrl` 先经 SSRF 策略校验（scheme/凭据/主机白名单/DNS 解析/重定向逐跳）再下载到 Hermes 缓存，Agent 拿到的是本地文件路径。
- **媒体支持**：文本、图片、语音、文件和视频消息（出站文件会先通过 `robot-gateway` 上传）。
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

## 前提

开始前请确保：

1. 已成功安装并初始化 [Hermes Agent](https://github.com/NousResearch/hermes-agent)。
2. 已配置好大模型（LLM provider、API key 等），并能在 `hermes tui` 窗口中正常对话。
3. 已部署可访问的 [robot-gateway](https://github.com/wildfirechat/robot-gateway)（默认端口 `8884`）。
4. 已在野火 IM 中创建机器人，并拿到 `robot_id` 和 `robot_secret`。

## 安装

### 方式一：目录插件（开发推荐）

```bash
# 克隆本仓库
git clone https://github.com/wildfirechat/robot-gateway.git

# 安装到 Hermes 插件目录（目录名可任意，这里使用和插件 manifest 一致的 wildfire-platform）
mkdir -p ~/.hermes/plugins
rsync -av --exclude='.venv' --exclude='.git' --exclude='*.egg-info' \
    robot-gateway/hermes-gateway.py/ ~/.hermes/plugins/wildfire-platform/
```

或者一键运行仓库里的安装脚本：

```bash
cd robot-gateway/hermes-gateway.py
bash scripts/install.sh
```

### 方式二：pip 包

```bash
cd robot-gateway/hermes-gateway.py
pip install -e .
# Hermes 会通过 `hermes_agent.plugins` entry point 自动发现该插件
```

## 配置

本插件的所有配置均通过**环境变量**读取，保持单一来源。写入 `~/.hermes/.env` 文件。

### 环境变量

所有配置项都通过环境变量读取，请写入 `~/.hermes/.env` 文件。

| 变量 | 必填 | 说明 |
|------|------|------|
| `WILDFIRE_GATEWAY_URL` | 是 | `ws://host:8884/robot/gateway` |
| `WILDFIRE_ROBOT_ID` | 是 | 野火 IM 机器人 ID |
| `WILDFIRE_ROBOT_SECRET` | 是 | 野火 IM 机器人密钥 |
| `WILDFIRE_HOME_CHANNEL` | 否 | **唯一**配置 home channel 的地方；`user:userId` 或 `group:groupId`，用于 cron 结果投递和跨平台消息 |
| `WILDFIRE_REQUIRE_MENTION` | 否 | 群聊是否必须 @ 机器人才回复，默认 `true`；设为 `false` 表示回复**所有**群消息（慎用） |
| `WILDFIRE_GROUP_KEYWORD_TRIGGERS` | 否 | 是否允许“`?`/`？` 结尾”或命中帮助关键词时无 @ 也回复，默认 `false` |
| `WILDFIRE_HELP_KEYWORDS` | 否 | 帮助关键词（仅在 `WILDFIRE_GROUP_KEYWORD_TRIGGERS=true` 时生效），默认 `帮,请,分析,总结,怎么,如何` |
| `WILDFIRE_ALLOWED_USERS` | 否 | 允许**私聊**机器人的用户 ID，逗号分隔；**空 = 不允许任何人私聊**（机器人 owner 始终允许） |
| `WILDFIRE_ALLOWED_GROUPS` | 否 | 允许机器人响应的群组/频道 ID，逗号分隔；**空 = 不在任何群回复**（owner 也一样） |
| `WILDFIRE_GROUP_ALLOWED_USERS` | 否 | 群内发送者白名单，逗号分隔；**空 = 白名单群内任何成员都可以**（owner 始终允许） |
| `WILDFIRE_ALLOW_ALL_USERS` | 否 | 设为 `true` 时允许所有人（私聊+群聊，无需其他白名单）；仅开发/受控环境使用 |
| `WILDFIRE_RATE_LIMIT_PER_MINUTE` | 否 | 每个发送者每分钟最多触发的消息数，默认 `20`，`0` 关闭 |
| `WILDFIRE_GROUP_RATE_LIMIT_PER_MINUTE` | 否 | 每个群每分钟最多触发的消息数，默认 `60`，`0` 关闭 |
| `WILDFIRE_PROFILE_FETCH_RETRIES` | 否 | 启动时 `getProfile` 取 owner 的重试次数，默认 `3`；失败后保持 fail-closed |
| `WILDFIRE_MEDIA_ALLOWED_HOSTS` | 否 | 入站媒体 URL 主机白名单，逗号分隔，支持 `*.example.com`（只匹配子域）；空 = 不限主机 |
| `WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS` | 否 | 是否允许媒体 URL 解析到 RFC1918/CGNAT/ULA 私网地址，默认 `true`（兼容私有化部署） |
| `WILDFIRE_MEDIA_MAX_REDIRECTS` | 否 | 入站媒体下载最多跟随的重定向次数，默认 `3` |
| `WILDFIRE_RECONNECT_INTERVAL` | 否 | 自动重连间隔（秒），默认 `5.0` |
| `WILDFIRE_RECONNECT_WAIT_TIMEOUT` | 否 | 发送超时后等待重连完成的最长时间（秒），默认 `2.0` |
| `WILDFIRE_REQUEST_TIMEOUT` | 否 | robot-gateway 请求超时时间（秒），默认 `30.0` |

> 也可以通过 `config.yaml` 的 `extra` 配置同名小写键（如 `allowed_groups`、`media: {allowedHosts, allowPrivateHosts, maxRedirects}`）；环境变量优先。

### `~/.hermes/.env` 示例

```bash
# Wildfire IM robot-gateway endpoint
WILDFIRE_GATEWAY_URL=ws://localhost:8884/robot/gateway
WILDFIRE_ROBOT_ID=YourRobotId
WILDFIRE_ROBOT_SECRET=YourRobotSecret

# Home channel for cron results / cross-platform notifications
# user:userId or group:groupId
WILDFIRE_HOME_CHANNEL=user:alice

# Group behavior: mention-only by default
WILDFIRE_REQUIRE_MENTION=true
# WILDFIRE_GROUP_KEYWORD_TRIGGERS=true
WILDFIRE_HELP_KEYWORDS="帮,请,分析,总结,怎么,如何"

# Access control (fail-closed: empty allowlists admit nobody except the owner)
WILDFIRE_ALLOWED_USERS="alice,bob"
WILDFIRE_ALLOWED_GROUPS="group-1,group-2"
# WILDFIRE_GROUP_ALLOWED_USERS="alice,bob"   # optional: restrict group senders
# WILDFIRE_ALLOW_ALL_USERS=true             # dev only: opens DMs and groups to everyone

# Rate limits (messages per minute; 0 disables)
WILDFIRE_RATE_LIMIT_PER_MINUTE=20
WILDFIRE_GROUP_RATE_LIMIT_PER_MINUTE=60

# Inbound media URL policy (SSRF hardening)
# WILDFIRE_MEDIA_ALLOWED_HOSTS=cdn.example.com,*.example.org
WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS=true
WILDFIRE_MEDIA_MAX_REDIRECTS=3

# Connection tuning (seconds)
WILDFIRE_RECONNECT_INTERVAL=5.0
WILDFIRE_RECONNECT_WAIT_TIMEOUT=2.0
WILDFIRE_REQUEST_TIMEOUT=30.0
```

> 注意：本插件不支持聊天里的 `/sethome` 命令。

## 访问控制与安全

### 私聊 vs 群聊

| 场景 | 判定 |
|------|------|
| 私聊 owner | 始终允许（owner 由启动时的 `getProfile` 获取） |
| 私聊其他用户 | 必须在 `WILDFIRE_ALLOWED_USERS` 中，否则静默忽略 |
| 群聊任意消息 | 群必须在 `WILDFIRE_ALLOWED_GROUPS` 中，否则静默忽略 |
| 群聊发送者 | 配置了 `WILDFIRE_GROUP_ALLOWED_USERS` 时必须在列表内；未配置时该群任何成员都可以 |
| `WILDFIRE_ALLOW_ALL_USERS=true` | 私聊和群聊都不再校验白名单 |

**Fail-closed**：没有配置任何白名单、且没有显式 `WILDFIRE_ALLOW_ALL_USERS=true` 时，除 owner 私聊外一律拒绝。启动时 `getProfile` 失败会重试；仍失败时只记录 ERROR 并保持 fail-closed，**不会**退化成“所有人可用”。因此升级后如果发现“只有 owner 能私聊、群聊没反应”，请先检查 `WILDFIRE_ALLOWED_GROUPS` / `WILDFIRE_GROUP_ALLOWED_USERS` 是否配置正确。

> 与 0.1.x 的差异：旧版本的“空 allowlist = 放行所有人”已移除；需要完全开放请显式设置 `WILDFIRE_ALLOW_ALL_USERS=true`。

### 群聊触发与限流

- 默认只有 @ 机器人的群消息会转发给 Agent；`?`/关键词触发需要 `WILDFIRE_GROUP_KEYWORD_TRIGGERS=true`。
- 每个发送者、每个群都有独立的一分钟滑动窗口限流；超限消息被丢弃并记录 WARNING 日志。
- 被访问控制/限流拦截的消息不会回复用户（仅日志），这属预期行为。

### 入站媒体

图片/语音/视频/文件消息里的 `mediaUrl` 来自消息 payload，任意 IM 用户都可以构造，因此下载前会执行 SSRF 校验：

- 仅允许 `http`/`https`，拒绝内嵌凭据的 URL；
- 可选的 `WILDFIRE_MEDIA_ALLOWED_HOSTS` 主机白名单（`*.example.com` 只匹配子域）；
- 解析所有 A/AAAA 记录：回环、链路本地（含云 metadata 地址/主机名）、组播/保留地址始终拒绝；RFC1918/CGNAT/ULA 由 `WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS` 控制；
- 重定向手动逐跳校验，默认最多 3 跳；下载大小上限 64MB、超时 30 秒。

校验通过后文件会落到 Hermes 的媒体缓存，事件里传的是本地路径。已知残留风险与 DSH 插件一致：DNS 校验与实际连接之间仍可能被 rebinding，需要更严格时可在连接层固定已校验的 IP。

## 启用并重启

安装并配置好 `.env` 后，启用插件并**重启 gateway**：

```bash
hermes plugins enable wildfire-platform
hermes gateway restart
```

> `hermes plugins enable` 只修改 `~/.hermes/config.yaml` 中的 `plugins.enabled` 列表；必须重启 gateway 进程才会加载插件并读取 `.env` 中的配置。

## 使用

Gateway 启动后：

```bash
hermes gateway status
```

你应该能看到 **Wildfire IM** 已作为已连接平台列出。

在野火 IM 中搜索你的机器人 ID 并开始聊天：

- **私聊**：机器人 owner 和 `WILDFIRE_ALLOWED_USERS` 中的用户会被转发给 Hermes；其他用户静默忽略。
- **群聊**：群必须在 `WILDFIRE_ALLOWED_GROUPS` 中；默认只有 @ 机器人的消息会转发（`?`/帮助关键词触发需显式开启）；配置了 `WILDFIRE_GROUP_ALLOWED_USERS` 时仅列表内成员可用。
- 被拦截的消息不会给发送者任何提示，只在 gateway 日志里记录原因（避免对陌生人暴露机器人存在）。

## 开发

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## 许可证

MIT
