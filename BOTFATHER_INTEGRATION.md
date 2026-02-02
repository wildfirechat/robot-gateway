# BotFather 功能集成文档

## 概述

BotFather 是一个集成在机器人网关中的自动机器人生成服务。用户可以通过向 BotFather 机器人发送聊天命令来创建和管理自己的机器人。

**重要提示**：BotFather **仅支持私聊**，群聊消息会被忽略。

### 核心特性

- ✅ **自动创建机器人**：用户通过 `/create` 命令即可创建机器人
- ✅ **统一回调管理**：回调地址由系统配置，用户无法修改
- ✅ **功能开关**：可通过配置随时启用/禁用功能
- ✅ **命令管理**：支持查看、更新、删除机器人
- ✅ **仅支持私聊**：只处理私聊消息，群聊消息会被忽略
- ✅ **内存缓存**：缓存用户机器人信息，提高响应速度

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       IM 服务器                              │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP 推送消息
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                   Gateway 网关服务                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           ServiceImpl.onReceiveMessage()               │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│          ┌───────────────┴───────────────┐                  │
│          ↓                               ↓                  │
│  ┌───────────────┐              ┌───────────────┐           │
│  │ BotFather     │              │  其他机器人    │           │
│  │ 消息路由       │              │  消息转发      │           │
│  └───────┬───────┘              └───────┬───────┘           │
│          ↓                              ↓                    │
│  ┌───────────────┐              ┌───────────────┐           │
│  │RobotCommand   │              │SessionManager │           │
│  │Handler        │              │              │           │
│  └───────┬───────┘              └───────┬───────┘           │
│          ↓                              ↓                    │
│  ┌───────────────┐              ┌───────────────┐           │
│  │RobotFather    │              │WebSocket      │           │
│  │Service        │              │客户端连接      │           │
│  └───────┬───────┘              └───────────────┘           │
└──────────┼──────────────────────────────────────────────────┘
           ↓
    ┌──────────────┐
    │ Server API   │
    │ UserAdmin    │
    └──────────────┘
```

### 核心组件

#### 1. BotFatherConfig
配置类，负责读取 BotFather 相关配置。

```java
@Component
@ConfigurationProperties(prefix = "botfather")
public class BotFatherConfig {
    private boolean enabled;
    private Robot robot;
    private Admin admin;
    private String callbackUrl;
    private String publicAddr;
}
```

#### 2. RobotFatherService
核心服务类，负责机器人的创建和管理。

主要方法：
- `getOrCreateRobot(String userId)` - 获取或创建机器人
- `createRobot(String userId)` - 创建新机器人（自动设置回调地址）
- `getUserCurrentRobot(String userId)` - 获取缓存的机器人
- `clearUserCache(String userId)` - 清除用户缓存

#### 3. RobotCommandHandler
命令处理器，解析和执行用户命令。

支持命令：
- `/help` - 显示帮助
- `/create` - 创建机器人
- `/info` - 查看信息
- `/list` - 列出机器人
- `/delete` - 删除机器人
- `/update` - 更新机器人

#### 4. ServiceImpl
消息路由，判断消息是否应该由 BotFather 处理。

路由逻辑：
```java
if (botFatherConfig.isEnabled() && isBotFatherMessage(targetRobotId)) {
    handleBotFatherMessage(messageData);
} else {
    // 原有的网关业务
    sessionManager.sendMessageToRobot(targetRobotId, messageData);
}
```

## 配置说明

### 完整配置示例

```properties
# ========== BotFather 配置 ==========

# 功能开关（true=启用，false=关闭）
botfather.enabled=true

# BotFather 机器人配置
botfather.robot.id=FireRobot
botfather.robot.name=小火
botfather.robot.secret=123456

# Server API配置（用于创建机器人）
botfather.admin.url=http://localhost:18080
botfather.admin.secret=YOUR_ADMIN_SECRET

# 服务回调地址配置
# 创建机器人时，自动设置此地址为机器人的回调地址
botfather.callbackUrl=http://192.168.3.101:8883

# 公网地址配置（必填）
# 用户连接此地址来使用创建的机器人
botfather.publicAddr=http://192.168.3.101:8883
```

### 配置项详解

| 配置项 | 必填 | 说明 |
|--------|------|------|
| botfather.enabled | 否 | 功能开关，设为 false 完全禁用 |
| botfather.robot.id | 是 | BotFather 机器人的 ID |
| botfather.robot.name | 是 | BotFather 机器人的显示名称 |
| botfather.robot.secret | 是 | BotFather 机器人的密钥 |
| botfather.admin.url | 是 | IM Server API地址 |
| botfather.admin.secret | 是 | IM Server API密钥 |
| botfather.callbackUrl | 是 | 新创建机器人的回调地址 |
| botfather.publicAddr | 是 | **网关公网地址（必填）**，用户连接此地址使用机器人 |

### 关键设计点

1. **回调地址统一管理**
   - 用户无法通过命令设置或修改回调地址
   - 所有机器人自动使用配置的回调地址
   - 保证回调地址的安全性和一致性

2. **公网地址必填**
   - `botfather.publicAddr` 是必填配置项
   - 创建机器人后会将此地址发送给用户
   - 用户使用此地址连接网关来操作机器人

3. **功能开关**
   - 通过 `botfather.enabled` 控制功能启停
   - 禁用时所有消息走原有网关业务
   - 不影响网关的其他功能

4. **内存缓存**
   - 缓存用户机器人信息，减少 API 调用
   - 提高响应速度
   - 缓存键：用户 ID
   - **自动恢复**：缓存丢失后自动从服务器重新加载

## 工作流程

### 创建机器人流程

```
用户发送 /create 命令
         ↓
Controller.recvMsg() 接收消息
         ↓
ServiceImpl.onReceiveMessage()
         ↓
判断：botfather.enabled == true ?
         ↓ 是
判断：targetRobotId == botfather.robot.id ?
         ↓ 是
handleBotFatherMessage()
         ↓
提取消息内容
         ↓
RobotCommandHandler.handleCommand()
         ↓
RobotFatherService.getOrCreateRobot()
         ↓
┌─────────────────────────────────┐
│ 检查内存缓存 userRobotCache      │
└─────────────────────────────────┘
         ↓ (未命中)
┌─────────────────────────────────┐
│ UserAdmin.getUserRobots(userId)  │
│ 查询服务器已有机器人              │
└─────────────────────────────────┘
         ↓ (无机器人)
┌─────────────────────────────────┐
│ createRobot(userId)             │
│ 1. 生成 robotId + robotSecret   │
│ 2. 设置回调地址（配置文件）       │
│ 3. UserAdmin.createRobot()      │
│ 4. 缓存到 userRobotCache        │
└─────────────────────────────────┘
         ↓
返回 RobotInfo(robotId, robotSecret)
         ↓
构造友好回复消息
         ↓
botFatherRobotService.replyMessage()
         ↓
用户收到机器人ID、密钥和网关地址
```

### 消息路由流程

```
IM 服务器推送消息
         ↓
ServiceImpl.onReceiveMessage()
         ↓
获取目标机器人 ID (getTargetRobotId)
         ↓
┌─────────────────────────────────┐
│ botfather.enabled == true ?     │
└─────────────────────────────────┘
         ↓ 否
┌─────────────────────────────────┐
│ 原有网关业务                     │
│ SessionManager.sendMessageToRobot│
└─────────────────────────────────┘
         ↓ 是
┌─────────────────────────────────┐
│ targetRobotId == botfather.id ? │
└─────────────────────────────────┘
         ↓ 否
┌─────────────────────────────────┐
│ 原有网关业务                     │
│ SessionManager.sendMessageToRobot│
└─────────────────────────────────┘
         ↓ 是
┌─────────────────────────────────┐
│ handleBotFatherMessage()        │
│ 判断是否需要响应（仅私聊）       │
└─────────────────────────────────┘
         ↓
提取消息内容（去除机器人名称）
         ↓
RobotCommandHandler.handleCommand()
         ↓
执行对应命令逻辑
         ↓
回复用户
```

### 响应判断逻辑

**BotFather 只支持私聊，群聊消息会被忽略。**

```java
private boolean shouldRespond(OutputMessageData messageData) {
    if (messageData.getConv() == null || messageData.getPayload() == null) {
        return false;
    }

    int convType = messageData.getConv().getType();

    // 仅处理私聊消息（type=0），忽略群聊消息
    return convType == 0;
}
```

## 命令详解

### /create - 创建机器人

**功能**：为用户创建新机器人或返回已有机器人信息

**响应**：
```
🤖 您的机器人信息：
━━━━━━━━━━━━━━━
🆔 机器人ID: robot_user123_1234567890
🔑 密钥: a1b2c3d4e5f6g7h8i9j0
🌐 网关地址: http://192.168.3.101:8883

📌 使用机器人ID和密钥连接到网关地址
```

**实现逻辑**：
1. 检查缓存中是否已有机器人
2. 如果没有，调用 `UserAdmin.getUserRobots()` 查询服务器
3. 如果服务器上也没有，创建新机器人
4. 自动设置回调地址为配置的 `botfather.callbackUrl`
5. 获取公网地址 `botfather.publicAddr`
6. 返回机器人ID、密钥和网关地址给用户

### /info - 查看机器人信息

**功能**：查看当前机器人的详细信息

**响应**：
```
🤖 机器人详细信息：
━━━━━━━━━━━━━━━
🆔 ID: robot_user123_1234567890
👤 名称: 我的机器人
🖼️ 头像: http://example.com/avatar.png
🔗 回调: http://192.168.3.101:8883
👤 拥有者: user123
📝 备注: 无
```

**重要特性**：
- 如果缓存为空（例如重启网关后），会自动从 IM 服务器重新加载机器人信息
- 用户数据不会因网关重启而丢失

### /list - 列出所有机器人

**功能**：显示用户拥有的所有机器人

**响应**：
```
🤖 您的机器人列表：
━━━━━━━━━━━━━━━
1. robot_user123_1234567890
2. robot_user123_9876543210

💡 共 2 个机器人
```

### /delete - 删除机器人

**功能**：删除当前缓存的机器人

**响应**：
```
✅ 机器人已删除

机器人ID: robot_user123_1234567890
```

### /update - 更新机器人

**功能**：更新机器人的名称、头像等信息

**用法**：
- `/update name 新名称` - 更新显示名称
- `/update portrait <URL>` - 更新头像URL
- `/update extra 备注` - 更新备注信息

**响应**：
```
✅ 更新成功

名称: 我的助手
```

## 安全考虑

### 1. 回调地址保护

用户无法通过以下方式修改回调地址：
- ❌ 命令行参数（已移除 `/create <callback_url>` 支持）
- ✅ 只有配置文件可以设置回调地址

### 2. Server API密钥

Server API密钥必须正确配置：
```properties
botfather.admin.secret=YOUR_ADMIN_SECRET
```

密钥错误将导致：
- 无法创建机器人
- 日志中会记录错误信息

### 3. 功能开关

可以通过配置随时禁用功能：
```properties
botfather.enabled=false
```

禁用后：
- BotFather 消息不会被处理
- 所有消息走原有网关业务
- 不影响其他机器人连接

## 性能优化

### 内存缓存

使用 `ConcurrentHashMap` 缓存用户机器人信息：

```java
private final Map<String, RobotInfo> userRobotCache = new HashMap<>();
```

**缓存策略**：
- 键：用户 ID
- 值：RobotInfo（robotId + robotSecret）
- 创建/查询机器人时写入
- 删除机器人时清除

**自动加载机制**：
- 当缓存为空时，会自动从 IM 服务器重新加载机器人信息
- 用户执行 `/info`、`/delete`、`/update`、`/callback` 等命令时，如果缓存为空，会自动从服务器加载
- 重启网关服务后，缓存会清空，但用户信息不会丢失，下次命令执行时自动加载

**优势**：
- 减少 API 调用次数
- 提高响应速度
- 降低服务器负载
- **容错性强**：缓存丢失后自动恢复

### 异步处理

使用 `@Async` 注解异步处理消息：

```java
@Override
@Async("asyncExecutor")
public void onReceiveMessage(OutputMessageData messageData) {
    // 处理逻辑
}
```

**优势**：
- 不阻塞主线程
- 支持高并发
- 提高系统吞吐量

## 错误处理

### 创建机器人失败

**可能原因**：
1. Server API密钥错误
2. 网络问题
3. IM 服务器异常
4. **公网地址未配置**

**错误响应**：
```
❌ 创建机器人失败，请稍后重试
```

或

```
❌ 系统配置错误，请联系管理员
```

**日志**：
```
ERROR BotFather public address is not configured
```
```

**日志**：
```
ERROR Failed to create robot, error: xxx
```

### 命令解析失败

**错误响应**：
```
❌ 未知命令：
/xxxxx

发送 /help 查看所有可用命令
```

### 获取机器人信息失败

**错误响应**：
```
💡 您还没有机器人

发送 /create 创建一个
```

## 扩展开发

### 添加新命令

在 `RobotCommandHandler.java` 中添加：

```java
// 1. 在 handleCommand 方法中添加命令判断
if (command.equals("/newcommand")) {
    return handleNewCommand(userId);
}

// 2. 实现命令处理方法
private String handleNewCommand(String userId) {
    // 实现逻辑
    return "处理结果";
}

// 3. 在 getHelpMessage 中添加说明
"📌 /newcommand - 新命令说明\n"
```

### 添加新的机器人属性

1. 在 `RobotInfo` 类中添加字段
2. 在 `createRobot` 方法中设置字段
3. 在 `/info` 命令中显示字段

### 集成其他服务

例如集成 Webhook 服务：

```java
@Autowired
private WebhookService webhookService;

private String handleCreate(String userId) {
    RobotInfo robotInfo = robotFatherService.getOrCreateRobot(userId);

    // 创建 webhook
    String webhookUrl = webhookService.createWebhook(robotInfo.getRobotId());

    return "机器人信息\n" +
           "Webhook: " + webhookUrl;
}
```

## 测试指南

### 单元测试

```java
@SpringBootTest
public class RobotFatherServiceTest {

    @Autowired
    private RobotFatherService robotFatherService;

    @Test
    public void testCreateRobot() {
        String userId = "test_user";
        RobotFatherService.RobotInfo robot = robotFatherService.getOrCreateRobot(userId);

        assertNotNull(robot);
        assertNotNull(robot.getRobotId());
        assertNotNull(robot.getRobotSecret());
    }
}
```

### 集成测试

1. 启动 Gateway 服务
2. 向 BotFather 机器人发送 `/create` 命令
3. 验证返回的机器人 ID 和密钥
4. 使用返回的凭据连接 Gateway
5. 验证机器人能正常收发消息

### 压力测试

```bash
# 使用 Apache Bench 测试
ab -n 1000 -c 10 \
   -H "Content-Type: application/json" \
   -p message.json \
   http://localhost:8883/robot/recvmsg
```

## 故障排查

### BotFather 不响应

**检查项**：
1. ✅ `botfather.enabled=true`
2. ✅ `botfather.robot.id` 配置正确
3. ✅ BotFather 机器人已创建
4. ✅ 查看日志是否有错误

### 创建机器人失败

**检查项**：
1. ✅ Server API地址正确：`botfather.admin.url`
2. ✅ Server API密钥正确：`botfather.admin.secret`
3. ✅ **公网地址已配置：`botfather.publicAddr`**
4. ✅ 网络连接正常
5. ✅ IM 服务器运行正常

### 回调地址未生效

**检查项**：
1. ✅ `botfather.callbackUrl` 已配置
2. ✅ 回调地址可访问
3. ✅ 防火墙规则正确

## 总结

BotFather 功能为机器人网关提供了自动创建机器人的能力，通过简单的聊天命令即可管理机器人，大大降低了使用门槛。统一配置的回调地址保证了安全性，功能开关提供了灵活性，是网关服务的重要扩展功能。
