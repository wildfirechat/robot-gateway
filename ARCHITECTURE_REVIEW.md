# robot-gateway 项目架构梳理报告

> 本文档基于源码与文档（README.md、ARCHITECTURE.md、各模块 README、核心类实现）梳理
> 完成日期：2026-02-xx ｜ 版本：1.0

---

## 1. 项目概述

**野火IM机器人网关服务**（robot-gateway）解决的核心问题是：

> 野火IM机器人服务需要与 IM 服务通过 HTTP 直接通信，要求机器人部署在 IM 服务可达的地址（同内网或公网 IP）。本网关把 **HTTP/RobotService 接口转换为 WebSocket 接口**，让机器人客户端可以位于任意内网，通过 WebSocket 长连接与 IM 服务双向沟通，同时不暴露 IM 服务的内部细节。

项目还附带了一套完整的**机器人生态**：多语言客户端 SDK（Java/JS/Go）、多个 AI 平台对接插件（DSH、OpenClaw、Hermes、cc-connect）、以及类 Telegram BotFather 的**机器人工厂**（用户通过聊天命令自助创建机器人）。

---

## 2. 系统架构总览

```
┌─────────────────┐   WebSocket    ┌─────────────────┐  HTTP/RobotService  ┌──────────────┐
│  机器人客户端     │   :8884        │     网关服务      │   :8885             │              │
│  (Java/JS/Go SDK│ ←鉴权+转发→     │   (无状态代理)    │ ←────────────────→  │    IM服务     │
│   或 AI 插件)    │                │                  │                     │              │
└─────────────────┘                └─────────────────┘                     └──────────────┘
        ▲                                  │
        │  WebSocket 长连接                 │ HTTP Webhook (/robot/recvmsg)
        │  每个连接动态创建                  │ 消息推送方向
        │  RobotService 实例                ▼
```

**设计原则**（来自 ARCHITECTURE.md 与源码验证）：
1. **无状态代理**：网关不持久保存机器人信息，每个 WebSocket 会话在鉴权成功后动态创建独立的 `RobotService` 实例。
2. **动态鉴权**：连接建立后必须先发 `connect` 消息鉴权，通过后才能发请求。
3. **异步处理**：`@Async` 线程池处理消息，避免阻塞 IO 线程（10 核心 / 10 最大 / 100 队列）。
4. **线程安全**：服务端 `ConcurrentHashMap` 管理会话；客户端 `ConcurrentHashMap + CompletableFuture` 支持并发请求。
5. **自动重连**：客户端断线自动重连并重新鉴权；鉴权失败即清空凭据、停止重试，避免死循环。

---

## 3. 模块清单与职责

### 3.1 Maven 多模块（Java，父 POM `pom.xml`）

| 模块 | 职责 | 输出 |
|------|------|------|
| `gateway/` | **网关服务**（Spring Boot），双端口：HTTP 8885 收 IM Webhook，WebSocket 8884 接客户端 | `gateway-1.0.0.jar` |
| `client/` | **Java 客户端 SDK**，实现与 RobotService 对齐的完整 API | `client-1.0.0.jar` |
| `demo/` | 交互式 Demo（send/info/group/profile/status 等命令） | `demo-1.0.0.jar` |
| `openclaw-adapter/` | **Java 版 OpenClaw 桥接器**：野火 IM ↔ OpenClaw Gateway 双向通信、流式文本、白名单 | `openclaw-adapter-1.0.0.jar` |

### 3.2 gateway 核心类（`cn.wildfirechat.app`）

| 类 | 职责 |
|----|------|
| `Application` | Spring Boot 启动类 |
| `Controller` | HTTP Webhook 接收器：`POST /robot/recvmsg`（消息）、`POST /robot/recvmsg/conference`（会议事件） |
| `ServiceImpl` | 消息分发核心：判定目标机器人 → BotFather 路由 → 按 robotId 转发给 WebSocket 会话 |
| `ExecutorConfig` | 异步线程池配置（`@EnableAsync`） |
| `config/WebSocketConfig` | WebSocket 端点注册（`/robot/gateway`）+ 额外 Tomcat Connector 实现 8884 独立端口 |
| `config/BotFatherConfig` | BotFather 配置项绑定 |
| `gateway/RobotGatewayEndpoint` | WebSocket 端点：连接/断开、鉴权消息处理、心跳处理、请求分发、消息大小限制（60KB） |
| `gateway/SessionManager` | 会话管理：sessionId↔robotId 映射、**多连接支持**（robotId→Set\<sessionId\>）、心跳超时清理（5 分钟）、未鉴权超时（1 分钟）、机器人上线/下线状态同步（平台号 7） |
| `gateway/RobotProxy` | 反射调用 `RobotService` SDK 方法；**安全屏蔽** `setCallback/getCallback/deleteCallback`；`getProfile` 返回前剥离 callback 与 secret |
| `gateway/AuthHandler` | 鉴权：调 IM `getProfile` 验证 secret，成功后创建 RobotService 实例 |
| `protocol/` | 四种消息模型：`ConnectMessage`（鉴权）、`RequestMessage`、`ResponseMessage`、`PushMessage` |
| `service/RobotFatherService` | **机器人工厂**：通过 Server API 自动创建机器人、缓存（30 分钟）、欢迎语、添加好友 |
| `service/RobotCommandHandler` | BotFather 命令处理：`/help /create /info /list /delete /update name|portrait` |

### 3.3 客户端 SDK 三语言实现（同构）

| 语言 | 位置 | 技术栈 | 说明 |
|------|------|--------|------|
| Java | `client/` | Java-WebSocket 1.5.3、Gson 2.8.9、野火IM Common SDK 1.4.3 | 参考实现 |
| JavaScript | `client.js/` | Node 18+、`@wildfirechat/server-sdk`（模型类） | 与 Java 功能对齐，ESM 模块 |
| Go | `go/sdk/` | gorilla/websocket（workspace：`go.work`） | 目录结构：`protocol/`（types、imresult）+ `client/`（handler、response_handler、websocket_client、connection_manager、robot_service_client） |

三者均含：`ConnectionManager`（连接生命周期/心跳/重连）、`RobotGatewayClient`（WebSocket 封装）、`RobotServiceClient`（完整 API）、`handler/`（MessageHandler、ResponseHandler）、`protocol/`（四消息模型）。

### 3.4 AI 平台对接插件（消费方，均依赖 robot-gateway + 各自 SDK）

| 插件 | 位置 | 技术栈 | 对接目标 | 特色 |
|------|------|--------|----------|------|
| DSH 渠道插件 | `dsh-plugin.js/` | TypeScript / Cordis 插件 | DeepSeek Harness（`dsh web`） | 会话隔离、流式回复、卡片更新、工作目录绑定（/cwd）、白名单、模型选择 |
| OpenClaw 频道插件 | `openclaw-plugin.js/` | TypeScript / OpenClaw 插件 | OpenClaw | 会话隔离、文件上传、流式回复（**README 推荐使用**） |
| Hermes 平台适配器 | `hermes-gateway.py/` | Python / Hermes 平台插件 | Hermes Agent | 双向桥接、draft streaming、输入提示、消息去重、会话隔离 |
| cc-connect 桥接 | `cc-connect-plugin.js/` | Node.js | cc-connect Bridge Server（→ Claude Code） | Bridge 协议双向转发、reply_stream 流式帧 |
| OpenClaw 适配器（JS 版） | `openclaw-adapter.js/` | Node.js | OpenClaw Gateway | 早期 JS 版实现（含 config/session/filter 结构） |

### 3.5 其他

| 目录 | 说明 |
|------|------|
| `go/openclaw-adapter/` | Go 版 OpenClaw 适配器：`cmd/main.go` + `internal/`（config、openclaw、converter、filter、session、bridge） |
| `lib/` | 本地依赖 `sdk-1.4.3.jar`、`common-1.4.3.jar`（野火 IM SDK） |
| `cn/wildfirechat` | 补充源码目录 |
| `build.sh` | 一键打包脚本（mvn package） |

---

## 4. 通信协议（WebSocket + JSON）

端点：`ws://gateway:8884/robot/gateway`

| 消息 | 方向 | 格式要点 |
|------|------|----------|
| 鉴权 | C→S | `{"type":"connect","robotId":"FireRobot","secret":"123456"}` |
| 鉴权响应 | S→C | `{"type":"connect","code":0,"msg":"success"}`（失败返回 401/404/500） |
| 请求 | C→S | `{"requestId":"uuid","method":"sendMessage","params":[...]}` |
| 响应 | S→C | `{"requestId":"uuid","code":0,"msg":"success","result":{...}}` |
| 推送 | S→C | `{"type":"message","data":{sender,conv,payload,fromUser,timestamp}}` |
| 心跳 | C→S | `{"type":"heartbeat","timestamp":...}`，间隔 270 秒 |

**请求-响应匹配**：客户端 UUID 生成 requestId，`ConcurrentHashMap<requestId, CompletableFuture>` 注册，响应按 requestId 回填；带超时（默认 30s）。

**错误码**：0 成功 / 400 格式错误 / 401 未鉴权或鉴权失败 / 404 机器人不存在 / 500 内部错误。

---

## 5. 关键机制

### 5.1 鉴权流程
```
客户端 ──connect(robotId,secret)──▶ 网关 ──getProfile(robotId)──▶ IM服务
                                        │ 验证 secret
                                        │ 创建 RobotService 实例并绑定会话
客户端 ◀──connect(code:0)────────── 网关
```
- 重复鉴权被拒绝（400 Already authenticated）。
- 鉴权成功后调用 IMSDK `setOnline(platform=7, true)` 标记机器人上线。

### 5.2 消息推送路由（IM → 客户端）
```
用户发消息 → IM服务 → HTTP POST /robot/recvmsg → ServiceImpl
   → 判定目标机器人（私聊取 conv.target，群聊取 toRobotId）
   → BotFather 机器人？→ RobotFatherService（仅私聊处理命令）
   → 否则 SessionManager.sendMessageToRobot(robotId, PushMessage)
   → 找到该 robotId 的所有 WebSocket 会话，逐个推送
```
- **多连接广播**：`robotSessionMap`（robotId → Set\<sessionId\>）支持同一机器人多客户端在线，消息广播给所有连接。
- 无在线连接时丢弃并告警日志。

### 5.3 API 调用流程（客户端 → IM）
```
客户端 ──RequestMessage──▶ 网关 RobotGatewayEndpoint
   → 校验鉴权 → 心跳特殊处理
   → RobotProxy：从会话取 RobotService → 反射 findMethod + convertParams → invoke
   → ResponseMessage 返回
```
- `RobotProxy` 屏蔽回调类方法（setCallback 等），`getProfile` 脱敏（去掉 callback/secret），防止客户端篡改机器人回调地址。

### 5.4 心跳与超时
- 客户端每 270s 发心跳；服务端更新心跳时间并回响应。
- 服务端定时清理：心跳超时 5 分钟、未鉴权超时 1 分钟的会话。

### 5.5 重连机制（客户端）
- 断线后若持有凭据则定时重连（默认 5s 间隔），重连成功后自动重新鉴权。
- **首次鉴权失败不保存凭据、不重连**；重连后鉴权失败清空凭据停止重试。

### 5.6 BotFather 机器人工厂
- 用户**私聊** BotFather 机器人发 `/create` → `RobotFatherService` 调 Server API（`AdminHttpUtils`）创建机器人 → 自动设置系统统一回调地址 → 自动加好友、发欢迎语 → 返回机器人 ID/密钥/网关公网地址。
- 命令：`/help /create /info /list /delete /update name <名称> /update portrait <URL>`。
- 缓存：内存 30 分钟缓存用户机器人信息，丢失后自动从 IM 恢复。
- 限制：`botfather.maxRobotsPerUser`（默认 1）控制每用户机器人上限；**仅私聊，群聊忽略**。

### 5.7 安全与运营
- `getProfile` 返回脱敏（secret/callback 不外泄）。
- 客户端无法调用回调管理方法。
- 消息大小限制 60KB，超限关闭连接（1008）。
- 健康检查：`curl :8885/actuator/health`。

---

## 6. 模块间关系与数据流总览

```
                     ┌────────────────────────────────────────────────────┐
                     │              robot-gateway 生态                     │
                     │                                                    │
  ┌────────────┐     │  ┌──────────────┐     ┌───────────────────────┐   │
  │  用户/群    │◀───▶│  │   IM 服务     │◀───▶│  gateway (Java 网关)   │   │
  │ 野火客户端   │ HTTP│  │ (im-server)  │ HTTP│  :8885 HTTP / :8884 WS│   │
  └────────────┘     │  └──────────────┘     └───────────┬───────────┘   │
                     │                                  │ WebSocket :8884 │
                     │                                  ▼                 │
                     │  ┌─────────────────────────────────────────────┐   │
                     │  │  机器人客户端侧（多选一，可同时在线）             │   │
                     │  │  • client (Java SDK) / client.js (JS SDK)   │   │
                     │  │  • go/sdk (Go SDK)                          │   │
                     │  │  • dsh-plugin.js → DSH Agent                │   │
                     │  │  • openclaw-plugin.js / openclaw-adapter →   │   │
                     │  │    OpenClaw                                 │   │
                     │  │  • hermes-gateway.py → Hermes Agent          │   │
                     │  │  • cc-connect-plugin.js → cc-connect         │   │
                     │  └─────────────────────────────────────────────┘   │
                     └────────────────────────────────────────────────────┘
```

**数据流要点**：
1. **下行（用户→机器人）**：野火客户端 → IM 服务 → Webhook(8885) → 网关按 robotId 路由 → WebSocket(8884) 推送 → 客户端 SDK/插件 → AI Agent。
2. **上行（机器人→用户）**：AI Agent → 客户端 SDK `sendMessage()` → WebSocket 请求 → 网关 `RobotProxy` 反射调用 `RobotService` → HTTP 调 IM 服务 → 用户收到。
3. **BotFather 特殊路径**：Webhook 到达 → 目标是 BotFather → 走 `RobotFatherService`（Server API 创建机器人）→ 新机器人回调地址统一指向网关。

---

## 7. 技术栈汇总

| 层 | 技术 |
|----|------|
| 网关 | Spring Boot 2.2.10、Spring WebSocket（Tomcat 额外 Connector）、野火 IM SDK 1.4.3、Gson、`@Async` 线程池 |
| Java 客户端 | Java-WebSocket 1.5.3、Gson 2.8.9、野火 IM Common SDK 1.4.3 |
| JS 客户端 | Node 18+、ESM、`@wildfirechat/server-sdk` |
| Go SDK | Go workspace（go.work）、WebSocket 客户端库 |
| DSH 插件 | TypeScript、Cordis 4（dsh 插件体系） |
| OpenClaw 插件 | TypeScript、OpenClaw 插件体系 |
| Hermes 适配器 | Python、Hermes 平台插件体系（`BasePlatformAdapter`） |
| cc-connect | Node.js、cc-connect Bridge 协议 |
| 构建 | Maven 多模块（父 POM）、`build.sh`、npm、go.work、pip/pyproject |

---

## 8. 部署形态

| 形态 | 说明 |
|------|------|
| 单机部署 | `java -jar gateway-1.0.0.jar`，开 8884（入站）/8885（IM 回调）/80（出站） |
| Systemd | `/etc/systemd/system/robot-gateway.service` 托管 |
| 客户端侧 | SDK 或插件进程可与网关分离部署（内网 → 公网网关 → IM） |
| 典型生产链路 | 公网部署网关 + 机器人插件进程（DSH/OpenClaw/Hermes）7×24 运行 |

---

## 9. 结论与观察

1. **架构清晰分层**：网关（协议转换/路由/鉴权）与消费方（SDK/插件）解耦，同一 WebSocket 协议支撑三语言 SDK 和五个 AI 平台插件，复用度极高。
2. **安全设计到位**：动态鉴权、getProfile 脱敏、回调方法屏蔽、消息大小限制、白名单/群聊过滤（插件侧）。
3. **多机器人/多连接**：会话管理器支持一机器人多连接广播、多机器人独立实例，BotFather 支撑自助创建。
4. **生态完整**：从 Java 参考实现 → JS/Go 同构移植 → DSH/OpenClaw/Hermes/cc-connect 插件，形成"一个网关 + 多入口"的机器人接入方案。
5. **可扩展方向**：网关本身无状态、易水平扩展；新增 AI 平台只需实现 WebSocket 协议客户端。
