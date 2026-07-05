# cc-connect-plugin

野火 IM 与 cc-connect 的桥接插件（Node.js 版）。

本服务一侧通过 `@wildfirechat/robot-gateway-client-sdk` 连接 `robot-gateway`，另一侧通过 **cc-connect Bridge 协议**连接 cc-connect 的 Bridge Server，实现双向消息转发。

## 架构

```
┌─────────────┐      WebSocket      ┌───────────────────┐      WebSocket      ┌─────────────┐
│   野火 IM    │ ◀─────────────────▶ │ cc-connect-plugin │ ◀─────────────────▶ │  cc-connect  │
│  用户 / 群   │                     │    (Node.js)      │   Bridge Protocol   │ BridgeServer │
└─────────────┘                     └───────────────────┘                     └─────────────┘
```

- **入站**：IM 消息经 `robot-gateway` 推送到插件，插件过滤后作为 `message` 帧转发给 cc-connect。
- **出站**：cc-connect 的 `reply` / `reply_stream` / `image` / `file` / `audio` 等帧经插件转回野火 IM。

## 安装

```bash
cd cc-connect-plugin.js
npm install
```

`postinstall` 会自动在 `~/.cc-connect-plugin/` 创建默认配置文件（若不存在）。

## 快速开始

### 1. 安装 cc-connect

推荐通过 npm 全局安装：

```bash
npm install -g cc-connect
cc-connect --version
```

### 2. 安装并检查 Claude Code

cc-connect 通过本地 Claude Code Agent 处理消息，因此需要先安装：

```bash
npm install -g @anthropic-ai/claude-code
```

验证安装：

```bash
which claude
claude --version
```

输出示例：

```
/Users/rain/.nvm/versions/node/v20.17.0/bin/claude
2.1.27 (Claude Code)
```

> **注意**：如果 `claude` 是符号链接，cc-connect 在子进程里可能无法正确解析相对路径。建议将链接改为绝对路径：
>
> ```bash
> rm /Users/rain/.nvm/versions/node/v20.17.0/bin/claude
> ln -s /Users/rain/.nvm/versions/node/v20.17.0/lib/node_modules/@anthropic-ai/claude-code/cli.js \
>   /Users/rain/.nvm/versions/node/v20.17.0/bin/claude
> ```
>
> 或者直接在 cc-connect 配置中指定绝对路径（见下文 `cmd` 字段）。

### 3. 配置 cc-connect

编辑 `~/.cc-connect/config.toml`：

```toml
data_dir = "~/.cc-connect/data"
attachment_send = "on"
language = "zh"
max_attachment_size_mb = 50

[log]
  level = "info"

[[projects]]
  name = "my-project"

  [projects.agent]
    type = "claudecode"

    [projects.agent.options]
      mode = "default"
      # 改成你实际的项目目录
      work_dir = "/path/to/your/project"
      # 如果 cc-connect 找不到 claude，可指定绝对路径
      cmd = "/Users/rain/.nvm/versions/node/v20.17.0/bin/claude"

  # cc-connect 要求每个 project 至少有一个 [[projects.platforms]]。
  # 我们实际使用全局 Bridge Server 接入野火 IM；这里用一个占位 platform 满足校验。
  # 如果你本来就在用 Telegram/飞书/钉钉等平台，可直接替换。
  [[projects.platforms]]
    type = "telegram"

    [projects.platforms.options]
      token = "dummy-token"

[bridge]
  enabled = true
  port = 9810
  token = "8368f80abaf6aaabe92fed53b3ec594f"
  cors_origins = ["*"]

[management]
  enabled = true
  port = 9820
  token = "6a4add7e214ebe433dbc8b09b6ecd7f6"
  cors_origins = ["*"]
```

关键字段说明：

| 字段 | 说明 |
|---|---|
| `projects.agent.options.work_dir` | Claude Code 的工作目录，建议改成你实际要操作的代码目录 |
| `projects.agent.options.cmd` | Claude Code 可执行文件路径，用绝对路径最稳妥 |
| `bridge.token` | Bridge Server 认证密钥，必须与插件配置一致 |
| `bridge.port` | Bridge Server 监听端口，默认 9810 |

> **提示**：
> - 插件**默认启用白名单**，且默认列表为空。这意味着如果不配置 `allowedUsers` / `allowedGroups`，所有消息都会被拒绝并回复 `未授权使用`。详见下文 [白名单配置](#白名单配置)。
> - `admin_from = "your-wildfire-user-id"` 可设置管理员，开启 `/shell`、`/dir` 等特权命令。
> - `allow_from = "your-wildfire-user-id"` 可限制只有指定用户能与机器人交互。

### 4. 配置本插件

编辑 `~/.cc-connect-plugin/config.json`：

```json
{
  "wildfire": {
    "gatewayUrl": "ws://your-gateway:8884/robot/gateway",
    "robotId": "your-robot-id",
    "robotSecret": "your-robot-secret"
  },
  "ccconnect": {
    "transport": "websocket",
    "url": "ws://localhost:9810/bridge/ws",
    "token": "8368f80abaf6aaabe92fed53b3ec594f",
    "platform": "wildfire",
    "project": "",
    "capabilities": ["text", "image", "file", "audio", "typing", "update_message", "preview", "delete_message", "reconstruct_reply"],
    "reconnectInterval": 5000,
    "heartbeatInterval": 30000
  },
  "filter": {
    "whitelist": {
      "enabled": false,
      "allowedUsers": [],
      "allowedGroups": [],
      "deniedMessage": "未授权使用"
    },
    "group": {
      "enabled": true,
      "requireMention": true,
      "respondOnQuestion": true,
      "helpKeywords": "帮,请,分析,总结,怎么,如何",
      "allowedGroupIds": []
    }
  },
  "server": {
    "port": 8090
  }
}
```

确保 `ccconnect.token` 与 `~/.cc-connect/config.toml` 中的 `bridge.token` 一致。

### 5. 启动服务

**终端 1：启动 cc-connect**

```bash
cc-connect --config ~/.cc-connect/config.toml
```

看到以下日志表示 Bridge Server 已就绪：

```
bridge: server started addr=:9810 path=/bridge/ws
cc-connect is running
```

**终端 2：启动桥接插件**

```bash
cd /Users/rain/Workspace/robot-gateway/cc-connect-plugin.js
node bin/cc-connect-plugin.js
```

看到以下日志表示链路已打通：

```
[wildfire] connected as your-robot-id
[cc-connect] registered
[bridge] started
```

### 6. 测试使用

在野火 IM 中给机器人发送消息，cc-connect 会调用本地 Claude Code 处理并返回结果。

## 配置

配置文件优先级：

1. `-config <path>` 命令行参数
2. `~/.cc-connect-plugin/config.json`
3. 环境变量
4. 内置默认值

### 配置文件示例

见 `config.example.json`。

关键字段：

| 字段 | 说明 | 默认值 |
|---|---|---|
| `wildfire.gatewayUrl` | robot-gateway WebSocket 地址 | `ws://localhost:8884/robot/gateway` |
| `wildfire.robotId` | 机器人 ID | - |
| `wildfire.robotSecret` | 机器人密钥 | - |
| `ccconnect.url` | cc-connect Bridge WebSocket 地址 | `ws://localhost:9810/bridge/ws` |
| `ccconnect.token` | Bridge 认证令牌 | - |
| `ccconnect.platform` | 注册到 cc-connect 的平台名称 | `wildfire` |
| `ccconnect.project` | 绑定到指定 cc-connect 项目 | - |
| `ccconnect.capabilities` | 声明的能力列表 | 见 `config.example.json` |
| `filter.whitelist.enabled` | 是否启用白名单 | `true` |
| `filter.whitelist.allowedUsers` | 允许使用的用户 ID 列表 | `[]` |
| `filter.whitelist.allowedGroups` | 允许使用的群聊 ID 列表 | `[]` |
| `filter.whitelist.deniedMessage` | 被白名单拒绝时的回复内容 | `未授权使用` |
| `filter.group.requireMention` | 群聊是否需要 @ 才回复 | `true` |
| `filter.group.helpKeywords` | 群聊触发关键词 | `帮,请,分析,总结,怎么,如何` |
| `server.port` | HTTP 健康检查端口 | `8090` |

### 环境变量

- `WILDFIRE_GATEWAY_URL`
- `WILDFIRE_ROBOT_ID`
- `WILDFIRE_ROBOT_SECRET`
- `CCCONNECT_URL`
- `CCCONNECT_TOKEN`
- `CCCONNECT_PLATFORM`
- `CCCONNECT_PROJECT`
- `SERVER_PORT`

## 白名单配置

本插件**默认启用白名单**（`filter.whitelist.enabled: true`）。当白名单启用且 `allowedUsers` / `allowedGroups` 为空时，所有消息都会被拒绝，并回复 `deniedMessage` 中的内容（默认 `"未授权使用"`）。

这是为了安全考虑：机器人连接了本地 Claude Code，默认不应允许任何陌生人使用。

### 配置示例

```json
{
  "filter": {
    "whitelist": {
      "enabled": true,
      "allowedUsers": ["alice", "bob"],
      "allowedGroups": ["group123"],
      "deniedMessage": "未授权使用"
    }
  }
}
```

### 规则说明

- `allowedUsers`：允许使用机器人的野火用户 ID 列表。
- `allowedGroups`：允许使用机器人的野火群 ID 列表（仅对群聊生效）。
- 当 `enabled` 为 `true` 且 `allowedUsers` / `allowedGroups` 都为空时，所有消息都会被拒绝。
- 要关闭白名单，将 `enabled` 设为 `false`：

```json
{
  "filter": {
    "whitelist": {
      "enabled": false
    }
  }
}
```

### 环境变量

- `CCCONNECT_WHITELIST_ENABLED=true|false`
- `CCCONNECT_WHITELIST_USERS=alice,bob`
- `CCCONNECT_WHITELIST_GROUPS=group123`

## 运行

```bash
# 前台运行
npm start

# 指定配置文件
node bin/cc-connect-plugin.js -config ./config.json
```

## 健康检查

- `GET /health`：返回服务整体健康状态
- `GET /status`：返回 wildfire / cc-connect 连接状态及会话数

## Bridge 协议映射

### 野火 -> cc-connect

| 野火消息 | cc-connect 帧 | 说明 |
|---|---|---|
| 单聊文本 | `message` | `session_key = wildfire:{userId}:{userId}` |
| 群聊文本 | `message` | `session_key = wildfire:{groupId}:{senderId}` |
| 图片/文件/语音 | `message` | 以远程 URL 形式放入 `images` / `files` / `audio` |
| @ 机器人 | `message` | 正常转发，由 cc-connect 引擎处理 |

`reply_ctx` 使用内部生成的 `streamId`，用于后续流式回复路由。

### cc-connect -> 野火

| cc-connect 帧 | 野火消息 | 说明 |
|---|---|---|
| `preview_start` | `StreamingTextGeneratingMessageContent` | 创建流式占位消息 |
| `reply_stream` | `StreamingTextGeneratingMessageContent` | 增量更新流式消息 |
| `reply` | `StreamingTextGeneratedMessageContent` 或普通文本 | 最终回复 |
| `update_message` | 更新已有消息 | 通过 `preview_handle` 匹配 |
| `image` / `file` / `audio` | 上传后发送对应媒体类型 | base64 数据上传至 Wildfire |
| `card` / `buttons` | 文本消息 | 降级为 Markdown/文本 |
| `typing_start/stop` | 忽略 | - |

## 开发

```bash
npm run dev
```

## 常见问题

### 1. cc-connect 报错 `claudeSession: start: fork/exec ... no such file or directory`

原因：cc-connect 在子进程里找不到 `claude` 可执行文件，通常是符号链接或 PATH 问题。

解决：

- 确认 `claude` 存在：`which claude && claude --version`
- 在 `~/.cc-connect/config.toml` 中指定绝对路径：
  ```toml
  [projects.agent.options]
    cmd = "/Users/rain/.nvm/versions/node/v20.17.0/bin/claude"
  ```
- 或将 `claude` 符号链接改为绝对路径（见上文第 2 步）。

### 2. cc-connect 报错 `config: projects[0] needs at least one [[projects.platforms]]`

原因：cc-connect 要求每个 project 至少配置一个 platform。

解决：在 `[[projects]]` 下添加一个占位 platform（如示例中的 `telegram`），或配置你真正使用的平台。该占位 platform 只用于满足校验，不影响 Bridge Server 工作。

### 3. 日志里一直有 `telegram: initial connection failed`

这是占位 platform 在尝试重连，不影响 Bridge 功能。如果你不需要 Telegram，可以换成其他不联网的 platform，或配置真实平台。

### 4. cc-connect 回复 `failed to start agent session`

可能原因：

- Claude Code 未登录：`claude auth login`
- `work_dir` 不存在或没有权限
- `cmd` 路径不正确

### 5. 特权命令（如 `/dir`、`/shell`）无法使用

在 `~/.cc-connect/config.toml` 的 project 中添加：

```toml
[[projects]]
  name = "my-project"
  admin_from = "your-wildfire-user-id"
```

## 多项目切换

如果需要在多个项目/工作目录间切换，有以下两种方式：

### 方式一：配置多个项目

在 `~/.cc-connect/config.toml` 中定义多个 `[[projects]]`，每个指向不同的 `work_dir`：

```toml
[[projects]]
  name = "robot-gateway"
  [projects.agent]
    type = "claudecode"
  [projects.agent.options]
    work_dir = "/Users/rain/Workspace/robot-gateway"
  [[projects.platforms]]
    type = "telegram"
    [projects.platforms.options]
      token = "dummy-token"

[[projects]]
  name = "android-chat"
  [projects.agent]
    type = "claudecode"
  [projects.agent.options]
    work_dir = "/Users/rain/Workspace/android-chat"
  [[projects.platforms]]
    type = "telegram"
    [projects.platforms.options]
      token = "dummy-token"
```

然后在 `~/.cc-connect-plugin/config.json` 中通过 `ccconnect.project` 指定要使用的项目：

```json
{
  "ccconnect": {
    "project": "android-chat"
  }
}
```

修改后**重启桥接插件**即可切换到目标项目。`project` 留空或不填则使用 cc-connect 的默认项目。

### 方式二：运行多个插件实例

如果需要**同时使用**多个项目，可以启动多个插件实例，每个指向不同项目：

```bash
# 实例1 - 指向 robot-gateway
node bin/cc-connect-plugin.js -config ./config-gateway.json

# 实例2 - 指向 android-chat
node bin/cc-connect-plugin.js -config ./config-android.json
```

每个配置文件设置不同的 `ccconnect.project` 和 `server.port`（避免端口冲突）。

## 注意事项

1. 请确保 cc-connect 的 Bridge Server 已启用且 token 一致。
2. 群聊过滤规则与 `openclaw-plugin.js` / `hermes-gateway.py` 保持一致：@机器人、问号结尾、帮助关键词可触发回复。
3. 媒体文件通过 `uploadFile` RPC 上传到 `robot-gateway`，再发送给野火 IM。
4. `card` / `buttons` 在野火 IM 中暂无原生支持，已降级为文本展示。
5. 当前默认声明 `card` / `buttons` 以外的能力；如需让 cc-connect 直接发送卡片，可在 `capabilities` 中加入 `card` / `buttons` 并扩展 `MessageConverter`。
