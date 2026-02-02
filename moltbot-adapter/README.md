# Moltbot Adapter 模块

## 概述

moltbot-adapter模块是野火IM机器人网关与Moltbot Gateway的桥接器，实现两个系统之间的双向通信和消息格式转换。支持私聊和群聊场景，并提供流式文本消息支持。

## 功能特性

- ✅ **双向桥接**：野火IM ↔ Moltbot Gateway
- ✅ **智能转换**：自动转换消息格式
- ✅ **用户白名单**：只处理指定用户和群组的消息（默认启用）
- ✅ **群聊过滤**：防刷屏策略（@回复、问号回复、关键词回复、白名单）
- ✅ **流式消息**：支持AI流式文本生成（正在输入/完成状态）
- ✅ **上下文管理**：使用runId跟踪消息上下文，确保正确回复
- ✅ **自动重连**：双方断线自动重连（最多重试10次）
- ✅ **健康检查**：提供HTTP接口监控状态

## 架构

```
野火IM → 野火网关 → Moltbot Adapter → Moltbot Gateway → AI
                    ←                      ←
```

## 配置

### 基础配置

编辑 `src/main/resources/application.properties`:

```properties
# 野火网关配置
wildfire.gateway.url=ws://localhost:8884/robot/gateway
wildfire.robot.id=YourRobotId
wildfire.robot.secret=YourRobotSecret

# Moltbot Gateway配置
moltbot.gateway.url=ws://127.0.0.1:18789
moltbot.gateway.token=  # 可选
moltbot.scope=wildfire-im

# 用户/群组白名单（默认启用）
moltbot.whitelist.enabled=true
moltbot.whitelist.allowed-users=user123,user456  # 允许的用户ID
moltbot.whitelist.allowed-groups=group789         # 允许的群组ID

# 群聊策略
moltbot.group.enabled=true
moltbot.group.respond-on-mention=true
moltbot.group.respond-on-question=true
moltbot.group.help-keywords=帮,请,分析,总结,怎么,如何
moltbot.group.allowed-ids=groupId1,groupId2  # 群聊白名单
```

## 使用

### 1. 打包

```bash
cd /Users/rain/Workspace/robot_server
mvn clean package -DskipTests
```

打包产物：`moltbot-adapter/target/moltbot-adapter-1.0.0.jar`

### 2. 运行

```bash
java -jar moltbot-adapter/target/moltbot-adapter-1.0.0.jar
```

### 3. 检查状态

```bash
# 健康检查
curl http://localhost:8080/actuator/health

# 详细状态
curl http://localhost:8080/moltbot/status

# 测试接口
curl http://localhost:8080/moltbot/test
```

## 消息流程

### 私聊

```
用户 → 野火IM → 野火网关 → Adapter → Moltbot → AI回复 → Adapter → 野火网关 → 用户
```

### 群聊（带过滤）

```
群成员 → 野火IM → 野火网关 → Adapter → [白名单检查] → [群聊策略检查] → Moltbot → AI回复 → 群成员
                                          ↓                  ↓
                                    在白名单？          符合条件？
                                    不在？→ 拦截        不符合？→ 拦截
```

## 群聊策略

群聊默认不直接响应，需满足以下条件之一：

1. **被@时回复**：消息中@机器人
2. **问号结尾**：消息以"?"或"？"结尾
3. **求助关键词**：包含"帮"、"请"、"分析"、"总结"、"怎么"、"如何"等
4. **白名单群聊**：在`allowed-ids`中配置的群聊

可以关闭群聊策略：
```properties
moltbot.group.enabled=false
```

## 部署架构

### 同机部署（推荐）

```
+-------------------------+
|   同一台服务器          |
|  ┌──────────────────┐  |
|  │ Moltbot Gateway  │  |
|  │ :18789          │  |
|  └────────┬─────────┘  |
|           │            |
|  ┌────────▼─────────┐  |
|  │ Moltbot Adapter  │  |
|  │ :8080           │  |
|  └────────┬─────────┘  |
|           │            |
|  ┌────────▼─────────┐  |
|  │ 野火网关         │  |
|  │ :8884           │  |
|  └──────────────────┘  |
+-------------------------+
```

### 异机部署

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

## API接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/actuator/health` | GET | Spring Boot健康检查 |
| `/moltbot/status` | GET | 详细状态（野火/Moltbot连接状态） |
| `/moltbot/test` | GET | 测试接口 |

### 健康检查响应示例

```json
{
  "wildfire": {
    "connected": true,
    "status": "UP"
  },
  "moltbot": {
    "connected": true,
    "status": "UP"
  },
  "bridge": "RUNNING"
}
```

## 协议说明

### OpenClaw Protocol 3

moltbot-adapter使用OpenClaw协议（Protocol 3）与Moltbot Gateway通信：

**连接流程：**
1. 客户端连接WebSocket
2. 服务端发送`connect.challenge`事件
3. 客户端发送`connect`请求（包含token、scopes等）
4. 服务端返回连接响应
5. 开始心跳和消息通信

**消息类型：**
- `req` - 请求消息（connect、chat.send等）
- `res` - 响应消息
- `event` - 事件消息（connect.challenge、agent、chat等）

## 日志

```properties
logging.level.cn.wildfirechat.moltbot=DEBUG
```

关键日志：
- `Connected to Wildfire Gateway` - 野火连接成功
- `Waiting for connect challenge event` - 等待Moltbot认证
- `Moltbot Gateway connection authenticated` - Moltbot认证成功
- `Converted Wildfire message to Moltbot` - 消息转换成功
- `Message from sender=xxx is not in whitelist, ignoring` - 白名单过滤
- `Message ignored by whitelist filter` - 白名单拦截
- `Group filter blocked the message` - 群聊策略拦截
- `Successfully sent message to Wildfire` - 发送成功
- `Agent event: runId=` - 流式消息生成中
- `Chat event: state=final` - 流式消息完成

## 故障排查

### 消息无响应

1. **检查白名单配置**
   - 确认`moltbot.whitelist.enabled`设置
   - 验证用户/群组ID是否在白名单中
   - 查看日志中的白名单过滤记录

2. **检查群聊策略**
   - 确认`moltbot.group.enabled`设置
   - 检查是否被@或包含关键词
   - 查看日志中的群聊策略过滤记录

3. **检查Moltbot Gateway**
   - 确认Moltbot Gateway是否运行
   - 检查网络连接（telnet 127.0.0.1 18789）
   - 验证token配置

### 群聊不回复

1. 检查群聊策略是否启用
2. 检查是否被@或包含关键词
3. 查看日志中的过滤记录
4. 验证白名单配置

### 野火连接断开

- Adapter会自动重连（SDK内置）
- 检查网关地址配置
- 查看鉴权信息

### 流式消息异常

**现象**：流式消息中断或状态不正确

**处理**：
1. 检查日志中的runId匹配情况
2. 确认Moltbot Gateway的流式事件是否正常
3. 查看agent和chat事件的处理记录

## 依赖

- Spring Boot 2.2.10
- Java-WebSocket 1.5.3
- Gson 2.8.9
- client模块（本地SDK）

## 下一步

- [ ] 添加会话统计接口
- [ ] 支持富文本消息转换
- [ ] 添加单元测试
- [ ] 支持多机器人配置
