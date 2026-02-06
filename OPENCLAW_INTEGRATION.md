# Moltbot Gateway 对接集成文档

## 概述

本文档描述了野火IM机器人网关与Moltbot Gateway的集成方案。通过openclaw-adapter模块，实现野火IM系统与Moltbot AI能力的无缝对接。

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     野火IM系统                                    │
│  用户发送消息 → RobotService → 野火网关(:8884)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (野火协议)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Moltbot Adapter Module (openclaw-adapter)             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 1. WildfireClient - 连接野火网关                          │  │
│  │ 2. MoltbotWebSocketClient - 连接Moltbot Gateway           │  │
│  │ 3. MessageConverter - 双向消息格式转换                    │  │
│  │ 4. SessionManager - 会话管理（私聊/群聊）                 │  │
│  │ 5. GroupFilter - 群聊防刷屏策略                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (Moltbot Protocol 3)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Moltbot Gateway (ws://127.0.0.1:18789)              │
│  • Session管理  • Agent路由  • 工具执行  • AI对话               │
└─────────────────────────────────────────────────────────────────┘
```

### 设计原则

1. **双向桥接**：野火IM ↔ Moltbot Gateway
2. **格式转换**：自动转换消息格式
3. **智能过滤**：群聊防刷屏策略
4. **会话保持**：维护多轮对话上下文
5. **容错机制**：自动重连、异常恢复

## 消息格式映射

### 野火IM → Moltbot Gateway

| 野火IM字段 | Moltbot Gateway字段 | 说明 |
|-----------|-------------------|------|
| `data.sender` | `channel.peerId` | 发送者用户ID |
| `data.conv.type` | `channel.isGroup` | 0=false, 1/2=true |
| `data.conv.target` | `channel.threadId` | 群聊时为groupId，私聊时为userId |
| `data.payload.content` | `message.text` | 文本消息内容 |
| `data.payload.type` | 消息类型判断 | 1=文本, 其他类型特殊处理 |
| 消息唯一ID | `message.id` | 生成UUID |
| 当前时间戳 | `message.timestamp` | System.currentTimeMillis() |
| `data.mentionedUsers` | `message.mentions` | @提及的用户列表 |

**示例**：
```json
// 野火IM PushMessage
{
  "type": "message",
  "data": {
    "sender": "user123",
    "conv": {
      "type": 0,
      "target": "user123",
      "line": 0
    },
    "payload": {
      "type": 1,
      "content": "你好"
    }
  }
}

// 转换为 Moltbot 消息
{
  "type": "message",
  "channel": {
    "id": "wildfire-im",
    "threadId": "user123",
    "peerId": "user123",
    "peerName": "user123",
    "isGroup": false
  },
  "message": {
    "id": "uuid-1234",
    "text": "你好",
    "timestamp": 1640000000000,
    "mentions": []
  }
}
```

### Moltbot Gateway → 野火IM

| Moltbot Gateway字段 | 野火IM字段 | 说明 |
|-------------------|-----------|------|
| `channel.peerId` | `target` | 目标用户ID |
| `channel.threadId` | `target` | 群聊时为groupId |
| `channel.isGroup` | `conversation.type` | true=1(群聊), false=0(单聊) |
| `message.text` | `payload.content` | AI回复文本 |
| `message.blocks` | (可选)富文本 | 工具调用结果 |

**示例**：
```json
// Moltbot 响应
{
  "type": "response",
  "channel": {
    "threadId": "user123",
    "peerId": "user123"
  },
  "message": {
    "text": "你好！有什么可以帮助你的吗？"
  }
}

// 转换为野火IM 发送请求
RobotService.sendMessage(
  "robotId",
  {
    "type": 0,
    "target": "user123",
    "line": 0
  },
  {
    "type": 1,
    "content": "你好！有什么可以帮助你的吗？"
  }
)
```

## Moltbot Gateway 协议

### 连接握手 (Protocol 3)

```json
{
  "type": "connect",
  "role": "channel",
  "scope": "wildfire-im",
  "protocol": 3,
  "minProtocol": 3,
  "maxProtocol": 3,
  "auth": {
    "type": "token",
    "token": "your-token"  // 可选
  }
}
```

### 发送消息格式

```typescript
interface MoltbotOutMessage {
  type: 'message';
  channel: {
    id: string;           // 通道标识 "wildfire-im"
    threadId: string;     // 群聊ID或私聊userId
    peerId: string;       // 用户ID
    peerName?: string;    // 用户名
    isGroup: boolean;     // 是否群聊
  };
  message: {
    id: string;           // 消息唯一ID
    text: string;         // 消息文本
    timestamp: number;    // 时间戳
    mentions?: Array<{    // 提及的用户
      id: string;
      name: string;
    }>;
  };
  session?: {
    id: string;  // 会话ID (基于threadId+peerId)
  };
}
```

### 接收响应格式

```typescript
interface MoltbotInMessage {
  type: 'response' | 'typing' | 'error';
  channel?: {
    threadId: string;
    peerId: string;
  };
  message?: {
    text: string;
    blocks?: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      content: any;
    }>;
  };
  meta?: {
    streaming?: boolean;
  };
  error?: string;
}
```

## 群聊防刷屏策略

参考飞书插件的低打扰模式实现：

### 策略条件

1. **被@时回复**：检测消息中是否@机器人
2. **问号结尾**：消息以"?"或"？"结尾
3. **求助关键词**：包含"帮"、"请"、"分析"、"总结"、"怎么"、"如何"等
4. **群聊白名单**：配置允许回复的群聊ID列表

### 实现逻辑

```java
boolean shouldRespondToGroup(MoltbotOutMessage msg) {
    // 策略1：被@时回复
    if (config.isRespondOnMention() &&
        containsMention(msg, botId)) {
        return true;
    }

    // 策略2：消息以问号结尾
    if (config.isRespondOnQuestion() &&
        msg.getMessage().getText().matches(".*[？?]$")) {
        return true;
    }

    // 策略3：包含求助关键词
    String text = msg.getMessage().getText();
    for (String keyword : config.getHelpKeywords()) {
        if (text.contains(keyword)) {
            return true;
        }
    }

    // 策略4：群聊白名单
    if (config.getAllowedGroups().contains(msg.getChannel().getThreadId())) {
        return true;
    }

    return false;
}
```

## 会话管理

### Session ID生成规则

```
私聊: {userId}
群聊: {groupId}

完整会话标识: {threadId}:{peerId}
```

### 会话生命周期

```
用户首次发送 → 创建Session → 发送到Moltbot
                    ↓
              维护上下文
                    ↓
              多轮对话
                    ↓
              超时清理（30分钟无活动）
```

## 配置参数

### application.properties

```properties
# ========================================
# 野火网关配置
# ========================================
wildfire.gateway.url=ws://localhost:8884/robot/gateway
wildfire.robot.id=YourRobotId
wildfire.robot.secret=YourRobotSecret
wildfire.reconnect.interval=5000

# ========================================
# Moltbot Gateway配置
# ========================================
moltbot.gateway.url=ws://127.0.0.1:18789
moltbot.gateway.token=
moltbot.scope=wildfire-im
moltbot.reconnect.interval=5000
moltbot.heartbeat.interval=30000

# ========================================
# 群聊策略配置
# ========================================
moltbot.group.enabled=true
moltbot.group.allowed-ids=
moltbot.group.respond-on-mention=true
moltbot.group.respond-on-question=true
moltbot.group.help-keywords=帮,请,分析,总结,怎么,如何

# ========================================
# 会话配置
# ========================================
moltbot.session.timeout=1800000
moltbot.session.max-sessions=1000

# ========================================
# 日志配置
# ========================================
logging.level.cn.wildfirechat.moltbot=DEBUG
```

## 部署架构

### 方案A：同机部署（推荐）

```
+-------------------------+
|   同一台服务器          |
|                         |
|  ┌──────────────────┐   |
|  | Moltbot Gateway  |   |
|  | :18789           |   |
|  └────────┬─────────┘   |
|           │              |
|  ┌────────▼─────────┐   |
|  | Moltbot Adapter  |   |
|  └────────┬─────────┘   |
|           │              |
|  ┌────────▼─────────┐   |
|  | 野火网关         |   |
|  | :8884           |   |
|  └──────────────────┘   |
+-------------------------+
```

**优势**：低延迟、简单部署

### 方案B：异机部署

```
服务器A (内网)          服务器B (公网)
┌──────────────┐       ┌──────────────┐
│ 野火网关     │       │ Moltbot      │
│ :8884       │──────▶│ Gateway      │
│              │       │ :18789       │
│              │       │              │
│ Moltbot     │◀──────│              │
│ Adapter     │       │              │
└──────────────┘       └──────────────┘
```

**要求**：
- 服务器A能访问服务器B的18789端口
- 或使用SSH隧道、Tailscale等网络方案

## API接口

### 健康检查

```http
GET http://localhost:8080/actuator/health
```

**响应**：
```json
{
  "status": "UP",
  "components": {
    "wildfire": {
      "status": "UP",
      "details": {
        "connected": true,
        "authenticated": true
      }
    },
    "moltbot": {
      "status": "UP",
      "details": {
        "connected": true
      }
    }
  }
}
```

### 会话统计

```http
GET http://localhost:8080/moltbot/sessions
```

**响应**：
```json
{
  "totalSessions": 150,
  "activeSessions": 45,
  "groupSessions": 30,
  "privateSessions": 120
}
```

### 发送测试消息

```http
POST http://localhost:8080/moltbot/test
Content-Type: application/json

{
  "userId": "test123",
  "text": "你好，测试消息"
}
```

## 消息流程

### 私聊流程

```
1. 用户发送消息给机器人
   ↓
2. 野火网关推送到Moltbot Adapter (WildfireClient)
   ↓
3. 转换为Moltbot格式 (MessageConverter)
   ↓
4. 发送到Moltbot Gateway
   ↓
5. Moltbot处理AI回复
   ↓
6. 接收AI响应 (MoltbotWebSocketClient)
   ↓
7. 转换为野火格式
   ↓
8. 通过RobotService发送到野火IM
   ↓
9. 用户收到AI回复
```

### 群聊流程（带过滤）

```
1. 群聊中有人@机器人或发送消息
   ↓
2. 野火网关推送
   ↓
3. 检测是否群聊 (isGroup=true)
   ↓
4. 应用群聊策略 (GroupFilter)
   ├─ 被@? → 通过
   ├─ 问号结尾? → 通过
   ├─ 包含关键词? → 通过
   ├─ 白名单群聊? → 通过
   └─ 其他 → 拦截（不发送）
   ↓
5. 通过策略 → 发送到Moltbot
   ↓
6. Moltbot AI回复
   ↓
7. 发送回复到群聊
```

## 错误处理

### Moltbot Gateway不可用

**现象**：WebSocket连接失败

**处理**：
1. 记录错误日志
2. 启动重连机制（5秒间隔）
3. 缓存未发送的消息（可选）
4. 提供告警通知

### 野火网关断开

**现象**：与野火网关的WebSocket连接断开

**处理**：
1. 自动重连（client SDK已支持）
2. 重新鉴权
3. 恢复后会话状态

### 消息格式错误

**现象**：无法解析消息

**处理**：
1. 记录原始消息
2. 跳过该消息，继续处理
3. 不影响其他消息

## 监控指标

### 关键指标

| 指标 | 说明 | 正常值 |
|------|------|--------|
| wildfire.connected | 野火网关连接状态 | true |
| wildfire.authenticated | 鉴权状态 | true |
| moltbot.connected | Moltbot连接状态 | true |
| session.count | 当前会话数 | <1000 |
| message.throughput | 消息吞吐量 | >10 msg/s |
| message.errorRate | 错误率 | <1% |

### 日志级别

```
DEBUG: 详细消息流、会话状态
INFO: 连接状态、重要事件
WARN: 重连、异常情况
ERROR: 失败、异常错误
```

## 故障排查

### 问题1：Moltbot无响应

**检查步骤**：
1. 确认Moltbot Gateway是否运行
2. 检查网络连接（telnet 127.0.0.1 18789）
3. 查看日志中的错误信息
4. 验证token配置

### 问题2：群聊不回复

**检查步骤**：
1. 确认群聊策略是否启用
2. 检查是否被@或包含关键词
3. 查看日志中的过滤记录
4. 验证白名单配置

### 问题3：会话上下文丢失

**检查步骤**：
1. 检查session超时配置
2. 查看SessionManager日志
3. 验证threadId是否一致

## 性能优化

### 连接池

- 保持与Moltbot Gateway的长连接
- 自动重连避免频繁断开

### 异步处理

- 使用@Async异步处理消息
- 避免阻塞主线程

### 会话清理

- 定期清理超时会话
- 限制最大会话数

## 安全建议

1. **Token管理**：使用环境变量存储token
2. **网络安全**：使用SSL/TLS加密通信
3. **输入验证**：验证所有输入参数
4. **访问控制**：限制管理接口访问
5. **日志脱敏**：敏感信息不记录日志

## 更新日志

### v1.0.0 (2025-02-01)
- ✅ 初始版本
- ✅ 支持私聊/群聊
- ✅ 群聊防刷屏策略
- ✅ 会话管理
- ✅ 自动重连
- ✅ 双向消息转换

---

**文档版本**：1.0.0
**最后更新**：2025-02-01
**维护者**：Wildfire IM Team
