# Openclaw Adapter 详细设计文档

## 1. 概述

### 1.1 项目定位

openclaw-adapter是野火IM与Openclaw Gateway之间的桥接适配器，负责：
- 双向消息格式转换
- 连接管理和自动重连
- 用户/群组白名单过滤
- 群聊防刷屏策略
- 流式文本消息处理
- 消息上下文跟踪

### 1.2 技术栈

- **框架**: Spring Boot 2.2.10
- **WebSocket客户端**: Java-WebSocket 1.5.3
- **JSON处理**: Gson 2.8.9
- **野火SDK**: client模块（本地依赖）

### 1.3 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                     野火IM系统                                    │
│  用户发送消息 → RobotService → 野火网关(:8884)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (野火协议)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              OpenclawAdapter (openclaw-adapter)                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    OpenclawBridge                         │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐ │  │
│  │  │ WildfireClient   │  │ OpenclawWebSocketClient       │ │  │
│  │  │ (SDK内置)        │  │ - 连接管理                    │ │  │
│  │  │ - 消息接收       │  │ - 认证握手                    │ │  │
│  │  │ - 自动重连       │  │ - 心跳保活                    │ │  │
│  │  │ - 消息发送       │  │ - 事件处理                    │ │  │
│  │  └────────┬─────────┘  │ - 请求追踪                    │ │  │
│  │           │            │ - 流式消息                    │ │  │
│  │           ▼            └───────────┬──────────────────┘ │  │
│  │  ┌─────────────────────────────────▼──────────────────┐ │  │
│  │  │           MessageConverter                         │ │  │
│  │  │  - 野火IM → Openclaw格式转换                         │ │  │
│  │  │  - Openclaw → 野火IM格式转换                         │ │  │
│  │  │  - 流式消息状态处理                                 │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │           WhitelistFilter                          │ │  │
│  │  │  - 用户白名单检测                                     │ │  │
│  │  │  - 群组白名单检测                                     │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │           GroupFilter                              │ │  │
│  │  │  - 被@检测                                          │ │  │
│  │  │  - 问号结尾检测                                      │ │  │
│  │  │  - 关键词检测                                        │ │  │
│  │  │  - 群聊白名单检测                                     │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (OpenClaw Protocol 3)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Openclaw Gateway (ws://127.0.0.1:18789)              │
│  • Session管理  • Agent路由  • 工具执行  • AI对话               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心模块设计

### 2.1 OpenclawBridge（桥接器核心）

**职责**：
- 初始化和管理两个WebSocket连接
- 双向消息转发
- 连接状态监控
- Openclaw连接重连

**关键方法**：
```java
// 生命周期
@PostConstruct void init()        // 启动时初始化
@PreDestroy void destroy()        // 关闭时清理
void start()                       // 启动桥接器
void stop()                        // 停止桥接器

// 野火消息处理
void onMessage(PushMessage)       // 接收野火消息
void onConnectionChanged(boolean) // 野火连接状态变化

// Openclaw消息处理
void onConnected()                // Openclaw连接成功
void onDisconnected(int, String)  // Openclaw连接断开
void onResponse(OpenclawInMessage) // 接收AI响应

// 状态查询
boolean isRunning()               // 桥接器运行状态
boolean isWildfireConnected()     // 野火连接状态
boolean isOpenclawConnected()      // Openclaw连接状态
```

**消息流转（野火 → Openclaw）**：
```
1. onMessage(PushMessage)
   ↓
2. WhitelistFilter.shouldProcess()
   ↓
3. MessageConverter.convertToOpenclaw()
   ↓
4. GroupFilter.shouldRespond()
   ↓
5. OpenclawWebSocketClient.sendMessage()
```

**消息流转（Openclaw → 野火）**：
```
1. onResponse(OpenclawInMessage)
   ↓
2. MessageConverter.convertFromOpenclaw()
   ↓
3. RobotServiceClient.sendMessage()
```

**重连机制**：
- 触发条件：`onDisconnected()`被调用
- 重连次数：最多10次
- 重连间隔：`openclaw.reconnect.interval`（默认5秒）
- 超时时间：每次重连最多等待5秒认证完成

### 2.2 OpenclawWebSocketClient（WebSocket客户端）

**职责**：
- WebSocket连接管理
- OpenClaw协议实现
- 认证和心跳
- 请求/响应匹配
- 流式事件处理
- 消息上下文管理

**核心数据结构**：
```java
// 认证状态
private volatile boolean isAuthenticated

// 请求追踪（requestId → PendingRequest）
private ConcurrentHashMap<String, PendingRequest> pendingRequests

// 消息上下文（runId → MessageContext）
private ConcurrentHashMap<String, MessageContext> messageContexts

// 心跳
private ScheduledExecutorService heartbeatExecutor
private volatile long lastHeartbeatTime
```

**PendingRequest结构**：
```java
class PendingRequest {
    String method;      // "connect" 或 "chat.send"
    String senderId;    // 原始发送者ID
    String threadId;    // 会话ID
    boolean isGroup;    // 是否群聊
    long timestamp;     // 请求时间戳
}
```

**MessageContext结构**：
```java
class MessageContext {
    String senderId;    // 原始发送者ID
    String threadId;    // 会话ID
    boolean isGroup;    // 是否群聊
}
```

**连接流程**：
```
1. connect() → 建立WebSocket连接
   ↓
2. onOpen() → 等待connect.challenge事件
   ↓
3. handleChallenge() → 发送connect请求
   ↓
4. handleResponse() → 验证认证结果
   ↓
5. startHeartbeat() → 启动心跳
```

**消息类型处理**：
```
onMessage(json)
  ├─ type="event" → handleEvent()
  │   ├─ event="connect.challenge" → handleChallenge()
  │   ├─ event="agent" → handleAgentEvent() [流式文本]
  │   ├─ event="chat" → handleChatEvent() [最终响应]
  │   └─ event="health"/"tick" → 忽略
  ├─ type="res" → handleResponse()
  │   ├─ method="connect" → 认证结果
  │   └─ method="chat.send" → 保存runId上下文
  └─ 其他 → handleOpenclawMessage()
      ├─ type="response" → onResponse()
      ├─ type="typing" → onTyping()
      └─ type="error" → onError()
```

**流式消息处理**：

**agent事件（流式生成中）**：
```java
handleAgentEvent(JsonObject):
  1. 提取runId、stream类型、data.text
  2. 查找messageContexts[runId]
  3. 构建OpenclawInMessage(type="streaming")
  4. 设置extra.streamId=runId, state="generating"
  5. 调用messageHandler.onResponse()
```

**chat事件（最终响应）**：
```java
handleChatEvent(JsonObject):
  1. 提取runId、state、message.content
  2. 查找messageContexts[runId]
  3. if state="final":
       - 构建OpenclawInMessage(type="response")
       - 设置extra.streamId=runId, state="completed"
       - 调用messageHandler.onResponse()
       - 清理messageContexts[runId]
  4. if state="error":
       - 调用messageHandler.onError()
       - 清理messageContexts[runId]
```

### 2.3 MessageConverter（消息转换器）

**职责**：
- 野火IM格式 ↔ Openclaw格式双向转换
- 文本内容提取
- 会话类型判断
- 流式消息元数据处理

**野火 → Openclaw转换**：
```java
convertToOpenclaw(PushMessage):
  1. 提取文本内容
     - type=1 → getSearchableContent()
     - 其他类型 → "[消息类型:X]" 或 null

  2. 判断会话类型
     - conv.type=0 → 私聊
     - conv.type=1/2 → 群聊

  3. 构建Channel
     - id="wildfire-im"
     - threadId = conv.type==0 ? sender : target
     - peerId = sender
     - isGroup = (type==1 || type==2)

  4. 构建Message
     - id = UUID()
     - text = 文本内容
     - timestamp = currentTimeMillis()
     - mentions = @提及列表（暂未实现）

  5. 生成Session
     - id = threadId + ":" + peerId
```

**Openclaw → 野火转换**：
```java
convertFromOpenclaw(OpenclawInMessage):
  1. 判断会话类型
     - isGroup = (threadId != null && threadId != peerId)

  2. 构建Conversation
     - type = isGroup ? 1 : 0
     - target = threadId ?? peerId
     - line = 0

  3. 构建MessagePayload
     - type = 1 (文本)
     - searchableContent = message.text

  4. 处理流式消息元数据
     if extra.streamId && extra.state:
       - state="generating" → StreamTextGeneratingMessageContent
       - state="completed" → StreamTextGeneratedMessageContent
       - 设置streamId和streamState

  5. 返回WildfireSendMessage
```

### 2.4 WhitelistFilter（白名单过滤器）

**职责**：
- 实现用户和群组白名单过滤
- 只处理白名单中的消息
- 记录被过滤的消息日志

**过滤逻辑**：
```java
shouldProcess(senderId, targetId, isGroup):
  1. if !config.enabled → return true (白名单未启用，处理所有消息)

  2. 检查用户白名单
     if senderId in allowedUsers → return true

  3. 检查群组白名单
     if isGroup && targetId in allowedGroups → return true

  4. 不在白名单中
     LOG.info("Message from sender={} is not in whitelist, ignoring")
     return false
```

**配置参数**：
```properties
openclaw.whitelist.enabled=true                  # 是否启用白名单
openclaw.whitelist.allowed-users=user123,user456 # 允许的用户ID列表
openclaw.whitelist.allowed-groups=group789       # 允许的群组ID列表
```

**过滤顺序**：
白名单过滤在消息处理流程的最前面，优先级高于群聊策略：
```
0. WhitelistFilter.shouldProcess()   [第0步：全局白名单]
   ↓
1. MessageConverter.convertToOpenclaw()  [第1步：格式转换]
   ↓
2. GroupFilter.shouldRespond()      [第2步：群聊策略]
```

### 2.5 GroupFilter（群聊过滤器）

**职责**：
- 实现群聊防刷屏策略
- 多条件组合判断
- 可配置的策略开关

**过滤策略**：
```java
shouldRespond(message, robotId):
  1. if !isGroup → return true (私聊总是响应)

  2. if !config.enabled → return false (策略未启用)

  3. if respondOnMention && isMentioned() → return true

  4. if respondOnQuestion && text.matches(".*[？?]$") → return true

  5. for keyword in helpKeywords:
       if text.contains(keyword) → return true

  6. if threadId in allowedIds → return true

  7. return false (默认不响应)
```

**配置参数**：
```properties
openclaw.group.enabled=true                    # 总开关
openclaw.group.respond-on-mention=true         # 被@时回复
openclaw.group.respond-on-question=true        # 问号结尾回复
openclaw.group.help-keywords=帮,请,分析,总结,怎么,如何
openclaw.group.allowed-ids=groupId1,groupId2   # 白名单
```

### 2.6 配置管理

#### OpenclawConfig
```java
@ConfigurationProperties(prefix = "openclaw.gateway")
- url: ws://127.0.0.1:18789
- token: 认证令牌（可选）
- scope: wildfire-im
- reconnectInterval: 5000ms
- heartbeatInterval: 30000ms
```

#### WhitelistConfig
```java
@ConfigurationProperties(prefix = "openclaw.whitelist")
- enabled: true                    # 是否启用白名单（默认启用）
- allowedUsers: List<String>       # 允许的用户ID列表
- allowedGroups: List<String>      # 允许的群组ID列表
```

**配置示例**：
```properties
openclaw.whitelist.enabled=true
openclaw.whitelist.allowed-users=user123,user456
openclaw.whitelist.allowed-groups=group789,group101
```

#### GroupStrategyConfig
```java
@ConfigurationProperties(prefix = "openclaw.group")
- enabled: true
- allowedIds: List<String>
- respondOnMention: true
- respondOnQuestion: true
- helpKeywords: "帮,请,分析,总结,怎么,如何"
```

#### SessionConfig
```java
@ConfigurationProperties(prefix = "openclaw.session")
- timeout: 1800000ms (30分钟)
- maxSessions: 1000
```

---

## 3. OpenClaw协议详解

### 3.1 连接认证流程

**步骤1：客户端连接**
```java
WebSocket.connect("ws://127.0.0.1:18789")
```

**步骤2：服务端发送挑战**
```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "xxx",
    "ts": 1234567890
  }
}
```

**步骤3：客户端发送认证请求**
```json
{
  "type": "req",
  "id": "uuid-request-id",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.0.0",
      "platform": "java",
      "mode": "cli"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": {
      "token": "your-token"  // 可选
    },
    "userAgent": "openclaw-adapter/1.0.0"
  }
}
```

**步骤4：服务端返回认证结果**
```json
{
  "type": "res",
  "id": "uuid-request-id",
  "ok": true,
  "payload": {
    "type": "connected",
    "protocol": 3,
    "policy": {
      "tickIntervalMs": 30000
    }
  }
}
```

### 3.2 发送消息（chat.send）

**请求格式**：
```json
{
  "type": "req",
  "id": "uuid-request-id",
  "method": "chat.send",
  "params": {
    "sessionKey": "main",
    "message": "用户消息内容",
    "idempotencyKey": "uuid-key"
  }
}
```

**响应格式**：
```json
{
  "type": "res",
  "id": "uuid-request-id",
  "ok": true,
  "payload": {
    "runId": "uuid-run-id"
  }
}
```

### 3.3 流式消息事件

**agent事件（流式生成中）**：
```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "runId": "uuid-run-id",
    "stream": "assistant",
    "data": {
      "text": "AI正在生成的内容..."
    }
  }
}
```

**chat事件（最终响应）**：
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "uuid-run-id",
    "state": "final",
    "message": {
      "content": [
        {
          "type": "text",
          "text": "AI最终回复内容"
        }
      ]
    }
  }
}
```

**chat事件（错误）**：
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "uuid-run-id",
    "state": "error",
    "errorMessage": "错误描述"
  }
}
```

### 3.4 心跳保活

**客户端发送**：
```java
sendPing()  // WebSocket协议层PING
```

**间隔**：`openclaw.heartbeat.interval`（默认30秒）

---

## 4. 消息格式映射

### 4.1 野火IM → Openclaw

| 野火IM字段 | Openclaw字段 | 说明 |
|-----------|------------|------|
| `data.sender` | `channel.peerId` | 发送者ID |
| `data.conv.type` | `channel.isGroup` | 0=false, 1/2=true |
| `data.conv.target` | `channel.threadId` | 群聊时=target，私聊时=sender |
| `data.payload.searchableContent` | `message.text` | 文本内容 |
| `data.payload.type` | (判断) | 1=文本，其他跳过 |
| UUID | `message.id` | 新生成UUID |
| currentTimeMillis | `message.timestamp` | 当前时间戳 |
| `data.mentionedUsers` | `message.mentions` | @提及（暂未实现） |

**threadId规则**：
- 私聊：使用`sender`作为threadId
- 群聊：使用`target`（groupId）作为threadId

### 4.2 Openclaw → 野火IM

| Openclaw字段 | 野火IM字段 | 说明 |
|-----------|-----------|------|
| `channel.peerId` | `target` | 目标用户ID |
| `channel.threadId` | `conversation.target` | 会话目标 |
| `channel.threadId != peerId` | `conversation.type=1` | 群聊判断 |
| `message.text` | `payload.searchableContent` | 文本内容 |
| `extra.streamId` | (流式消息) | StreamTextXXXMessageContent |
| `extra.state` | (状态) | generating/completed |

**流式消息类型**：
- `state="generating"` → `StreamTextGeneratingMessageContent(text, streamId)`
- `state="completed"` → `StreamTextGeneratedMessageContent(text, streamId)`

---

## 5. 健康检查设计

### 5.1 OpenclawHealthIndicator

**作用**：集成到Spring Boot Actuator

**健康状态**：
```java
{
  "wildfire": {
    "status": "UP" | "DOWN",
    "details": {
      "connected": true | false
    }
  },
  "openclaw": {
    "status": "UP" | "DOWN",
    "details": {
      "connected": true | false
    }
  }
}
```

### 5.2 OpenclawHealthController

**接口**：`GET /openclaw/status`

**响应**：
```json
{
  "wildfire": {
    "connected": true,
    "status": "UP"
  },
  "openclaw": {
    "connected": true,
    "status": "UP"
  },
  "bridge": "RUNNING" | "STOPPED"
}
```

**接口**：`GET /openclaw/test`

**响应**：
```json
{
  "message": "Openclaw Adapter is running",
  "wildfire": "Connected" | "Disconnected",
  "openclaw": "Connected" | "Disconnected"
}
```

---

## 6. 错误处理

### 6.1 Openclaw连接失败

**场景**：
- WebSocket连接失败
- 认证超时
- 认证被拒绝

**处理**：
```java
1. 记录错误日志
2. 触发重连机制（最多10次）
3. 超过重试次数后停止
4. 更新健康检查状态
```

### 6.2 消息发送失败

**场景**：
- chat.send返回ok=false
- 未认证时发送消息

**处理**：
```java
1. 记录错误日志
2. 检查认证状态
3. 如果未认证，等待重连完成
4. 调用messageHandler.onError()
```

### 6.3 消息格式错误

**场景**：
- 无法解析JSON
- 缺少必需字段
- 类型不匹配

**处理**：
```java
1. 记录原始消息
2. 记录错误详情
3. 跳过该消息
4. 继续处理后续消息
```

### 6.4 流式消息上下文丢失

**场景**：
- agent/chat事件找不到对应的runId

**处理**：
```java
1. 记录DEBUG日志
2. 跳过该事件
3. 不影响其他消息
```

### 6.5 白名单过滤

**场景**：
- 发送者用户或群组不在白名单中
- 白名单功能已启用

**处理**：
```java
1. 记录INFO日志：Message from sender=xxx is not in whitelist, ignoring
2. 记录INFO日志：Message ignored by whitelist filter
3. 直接返回，不处理该消息
4. 不影响其他消息
```

**日志示例**：
```
INFO - Message from sender=user111 (target=group222, isGroup=true) is not in whitelist, ignoring
INFO - Message ignored by whitelist filter: sender=user111, target=group222, isGroup=true
```

---

## 7. 性能考虑

### 7.1 内存管理

**pendingRequests**：
- 作用域：临时存储未完成请求
- 清理：收到响应后立即删除
- 预期大小：< 100

**messageContexts**：
- 作用域：存储流式消息上下文
- 清理：final/error状态后删除
- 预期大小：< 并发消息数

### 7.2 线程模型

**OpenclawReconnectThread**：
- 触发：连接断开时
- 生命周期：重连完成或超时后结束
- 守护线程：否

**OpenclawHeartbeatThread**：
- 启动：认证成功后
- 间隔：30秒
- 守护线程：是

### 7.3 连接池

当前设计使用单连接模式：
- 每个方向一个WebSocket连接
- 复用连接处理所有消息
- 自动重连保证高可用

---

## 8. 安全考虑

### 8.1 Token管理

```properties
# 使用环境变量或配置外部化
openclaw.gateway.token=${MOLTBOT_TOKEN:}
```

### 8.2 输入验证

- 消息内容长度限制（由Openclaw Gateway控制）
- JSON解析异常捕获
- NPE防护

### 8.3 日志脱敏

- 不记录敏感配置内容
- 日志中截断长文本（前50字符）
- 不记录token明文

---

## 9. 部署建议

### 9.1 同机部署（推荐）

```
+-------------------------+
|   同一台服务器          |
|  ┌──────────────────┐  |
|  │ Openclaw Gateway  │  |
|  │ :18789          │  |
|  └────────┬─────────┘  |
|           │            |
|  ┌────────▼─────────┐  |
|  │ Openclaw Adapter  │  |
|  │ :8080           │  |
|  └────────┬─────────┘  |
|           │            |
|  ┌────────▼─────────┐  |
|  │ 野火网关         │  |
|  │ :8884           │  |
|  └──────────────────┘  |
+-------------------------+
```

**优势**：低延迟、简单部署、网络稳定

### 9.2 异机部署

```
服务器A (内网)          服务器B (公网)
┌──────────────┐       ┌──────────────┐
│ 野火网关     │       │ Openclaw      │
│ :8884       │──────▶│ Gateway      │
│              │       │ :18789       │
│              │       │              │
│ Openclaw     │◀──────│              │
│ Adapter     │       │              │
└──────────────┘       └──────────────┘
```

**要求**：
- 服务器A能访问服务器B的18789端口
- 或使用SSH隧道、Tailscale等网络方案

---

## 10. 监控和运维

### 10.1 关键指标

| 指标 | 说明 | 正常值 |
|------|------|--------|
| wildfire.connected | 野火连接状态 | true |
| openclaw.connected | Openclaw连接状态 | true |
| openclaw.authenticated | Openclaw认证状态 | true |
| bridge.running | 桥接器运行状态 | true |

### 10.2 告警建议

- **连接断开**：wildfire或openclaw连接断开超过1分钟
- **认证失败**：Openclaw认证连续失败3次
- **消息错误率**：消息发送失败率 > 5%

### 10.3 日志配置

```properties
# 生产环境
logging.level.root=INFO
logging.level.cn.wildfirechat.openclaw=INFO

# 开发/调试
logging.level.cn.wildfirechat.openclaw=DEBUG
```

---

## 11. 扩展性设计

### 11.1 消息类型扩展

当前支持：
- 文本消息（type=1）

可扩展：
- 图片消息 → 转换为描述文本或URL
- 文件消息 → 转换为文件名或URL
- 语音消息 → 转换为ASR文本

### 11.2 策略扩展

GroupFilter可扩展：
- 时间窗口限流
- 用户黑白名单
- 消息频率限制
- 敏感词过滤

### 11.3 多机器人支持

可配置多个Openclaw Gateway实例：
- 按会话类型路由
- 按用户ID哈希路由
- 负载均衡

---

## 12. 版本历史

### v1.0.1 (2025-02-02)

**新增功能**：
- ✅ 用户/群组白名单过滤（WhitelistFilter）
- ✅ WhitelistConfig配置类
- ✅ 白名单日志记录
- ✅ 白名单默认启用

### v1.0.0 (2025-02-02)

**初始版本**：
- ✅ 双向消息桥接
- ✅ OpenClaw Protocol 3支持
- ✅ 群聊防刷屏策略
- ✅ 流式文本消息支持
- ✅ 消息上下文管理（runId）
- ✅ 自动重连机制
- ✅ 健康检查接口

---

**文档版本**：1.0.1
**最后更新**：2025-02-02
**维护者**：Wildfire IM Team
