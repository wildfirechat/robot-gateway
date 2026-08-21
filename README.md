# 野火IM机器人网关服务

基于WebSocket的野火IM机器人网关服务，提供Java客户端SDK。

## 项目简介

野火IM机器人服务可以通过HTTP双向与IM服务进行沟通，这就要求机器人服务需要部署在IM服务能够直接连接的地址上，通常是在同一个内网，或者机器人服务具有公网IP。

此服务是为了解决这个问题，可以让客户端处在内网中，通过此网关与IM服务进行双向沟通。

```
┌─────────────────┐   WebSocket   ┌─────────────────┐  HTTP/RobotService  ┌──────────────┐
│                 │   :8884       │                 │   :8885             │              │
│  Java客户端      │  ←鉴权+转发→   │     网关服务      │ ←────────────────→  │    IM服务    │
│  (Client SDK)   │               │   (无状态代理)    │                     │              │
│                 │               │                 │                     │              │
├─────────────────┤               ├─────────────────┤                     ├──────────────┤
│ RobotService    │               │ 每个连接动态创建   │                     │              │
│ Client          │               │ RobotService实例 │                     │              │
└─────────────────┘               └─────────────────┘                     └──────────────┘
```

### 模块
- gateway 网关，把机器人的HTTP接口转换为WebSocket接口。另外添加了机器人工厂功能，可以用户自己创建机器人，参考电报的BotFather。
- client 客户端SDK，实现了客户端WebSocket接口，可以直接使用。
- client.js js版客户端SDK，实现了客户端WebSocket接口，可以直接使用。
- demo 使用客户端SDK的Demo，演示如何使用SDK。
- openclaw-adapter OpenClaw的转换器，使用客户端SDK，实现了野火IM和OpenClaw的对接。
- openclaw-plugin OpenClaw的野火IM，使用 js 版客户端SDK，实现了野火IM和OpenClaw的对接，支持会话隔离，文件上传，建议使用。
- dsh-plugin.js DeepSeek Harness（dsh）的野火IM渠道插件，使用 js 版客户端SDK，把野火IM接入 DSH Agent，支持会话隔离与流式回复，建议使用。

### 特性

- ✅ **多机器人支持**：支持多个机器人同时连接，每个连接独立的RobotService实例
- ✅ **动态鉴权**：客户端连接后动态鉴权，网关不预先配置机器人信息
- ✅ **WebSocket通信**：使用WebSocket长连接，实时双向通信
- ✅ **异步处理**：服务端异步消息处理，支持高并发
- ✅ **心跳保活**：客户端自动心跳（4.5分钟间隔），连接断开自动重连
- ✅ **并发请求**：客户端SDK完全支持并发请求
- ✅ **完整SDK**：提供RobotService的完整Java SDK实现
- ✅ **BotFather集成**：支持自动创建机器人，用户通过聊天命令即可创建和管理机器人

## 快速开始

### 1. 前置条件

- Java 8 或更高版本
- Maven 3.6 或更高版本
- 野火IM服务已部署


### 2. 创建机器人工厂（BotFather）
进入到 im-server 数据库中执行
> 注意:
> 
> 下面`sql`语句中，robot的回调地址默认是 `http://127.0.0.1:8885/robot/recvmsg` 要根据实际情况配置。
> 默认`127.0.0.1`是假设`robot-gateway`和`im-server`是部署在同一台服务器上，且`robot-gateway`使用默认端口。
>
> 直接操作数据库，插入完成之后，需要重启 im-server
```sql
insert into t_user (`_uid`,`_name`,`_display_name`,`_portrait`,`_type`,`_dt`) values ('robotfather','robotfather','机器人工厂','https://static.wildfirechat.cn/botfather.png',1,1);
insert into t_robot (`_uid`,`_owner`,`_secret`,`_callback`,`_state`,`_dt`) values ('robotfather', 'robotfather', '123456', 'http://127.0.0.1:8885/robot/recvmsg', 0, 1);
```

### 3. 配置网关

#### 网关配置说明

| 配置项            | 说明            | 默认值              |
|----------------|---------------|------------------|
| server.port    | HTTP服务端口      | 8885             |
| websocket.port | WebSocket服务端口 | 8884             |
| im.url         | IM服务地址        | http://localhost |

#### BotFather 配置说明（可选）

网关集成了 BotFather 功能，支持用户通过聊天命令自动创建机器人。

| 配置项                    | 说明               | 默认值                    |
|------------------------|------------------|------------------------|
| botfather.enabled      | BotFather 功能开关   | false                  |
| botfather.robot.id     | BotFather 机器人 ID | -                      |
| botfather.robot.name   | BotFather 机器人名称  | -                      |
| botfather.robot.secret | BotFather 机器人密钥  | -                      |
| botfather.admin.url    | IM服务API地址        | http://localhost:18080 |
| botfather.admin.secret | IM服务API密钥        | -                      |
| botfather.callbackUrl  | 机器人回调地址          | -                      |
| botfather.publicAddr   | 网关公网地址           | -                      |

配置示例：

```properties
# HTTP服务端口（接收IM Webhook）
server.port=8885

# WebSocket服务端口（客户端连接）
websocket.port=8884

# IM服务的实际地址。如果不在同一个服务器上，请正确配置地址，端口默认是80
im.url=http://localhost
# ========== BotFather 配置 ==========

# 功能开关（设为 false 可完全禁用）
botfather.enabled=true

# BotFather 机器人信息
botfather.robot.id=robotfather
botfather.robot.name=机器人工厂
botfather.robot.secret=123456

# IM管理API配置（用于创建机器人）
botfather.admin.url=http://localhost:18080
botfather.admin.secret=123456

# 回调地址（创建机器人时自动设置，需要是网关的地址）
botfather.callbackUrl=http://127.0.0.1:8885/robot/recvmsg

# 网关公网地址
# 用户连接此地址来使用创建的机器人
botfather.publicAddr=ws://192.168.1.81:8884/robot/gateway
```

**重要提示**：
- 回调地址由系统统一配置，用户无法通过命令修改
- **网关公网地址是必填项**，创建机器人后会发送给用户
- Server API密钥必须正确配置，否则无法创建机器人
- 可以通过 `botfather.enabled=false` 完全禁用 BotFather 功能

### 5. 打包项目

```bash
# 使用打包脚本（推荐）
./build.sh

# 或手动打包
mvn clean package -DskipTests
```

打包产物：
- `gateway/target/gateway-1.0.0.jar` - 网关服务可执行JAR
- `client/target/client-1.0.0.jar` - 客户端SDK库
- `demo/target/demo-1.0.0.jar` - 示例程序可执行JAR
- `openclaw-adapter/target/openclaw-adapter-1.0.0.jar` - OpenClaw转换器示例


### 4. 启动网关服务
把gateway-1.0.0.jar上传到网关服务，执行启动命令：

```bash
nohup java -jar gateway/target/gateway-1.0.0.jar 2>&1 &
```

启动后：
- 监听HTTP 8885端口，等待IM服务的回调。
- 监听WebSocket 8884端口，等待客户端的websocket连入。

防火墙：
- 公网放开8884的入访权限。
- 开通与IM服务8885的入访权限。
- 开通与IM服务80端口的出访权限。

### 5. 安装OpenClaw野火IM插件

具体请参考[插件说明](./openclaw-plugin.js/README.md)

> 对接 DeepSeek Harness（dsh）请参考 [dsh-plugin.js](./dsh-plugin.js/README.md) 与 [DSH_INTEGRATION.md](./DSH_INTEGRATION.md)

### 6. 开始使用
现在，打开野火IM客户端，找到你的机器人（搜索**机器人ID**, 不是名字），开始对话吧！

私聊模式：
* 直接发送消息，AI会立即回复

群聊模式：
* @机器人提问
* 或者消息以问号结尾
* 或者包含"帮"、"分析"、"总结"等关键词

## 线上部署指南

### 部署 robot-gateway

```bash
# 1. 创建部署目录
mkdir -p /opt/robot-gateway
cd /opt/robot-gateway

# 2. 复制jar包
cp gateway/target/gateway-1.0.0.jar .

# 3. 创建配置文件，也可以从项目获取
mkdir -p config
cat > config/application.properties << EOF
server.port=8885
websocket.port=8884
im.url=http://your-im-server
EOF

# 4. 启动服务
java -Xms512m -Xmx2g \
     -XX:+UseG1GC \
     -jar gateway-1.0.0.jar \
     --spring.config.location=file:config/application.properties
```

#### 使用Systemd管理

创建 `/etc/systemd/system/robot-gateway.service`：

```ini
[Unit]
Description=Robot Gateway Service
After=network.target

[Service]
Type=simple
User=robot
WorkingDirectory=/opt/robot-gateway
ExecStart=/usr/bin/java -jar /opt/robot-gateway/gateway-1.0.0.jar \
  --spring.config.location=file:/opt/robot-gateway/config/application.properties
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable robot-gateway
sudo systemctl start robot-gateway
sudo systemctl status robot-gateway
```

#### 健康检查

```bash
# 检查HTTP端口
curl http://localhost:8885/actuator/health

# 检查WebSocket端口（需要安装wscat）
wscat -c ws://localhost:8884/robot/gateway
```

## BotFather 功能说明

网关集成了 BotFather 功能，用户可以直接向 BotFather 机器人发送命令来创建和管理机器人。

**重要提示**：BotFather **仅支持私聊**，群聊消息会被忽略。

### 支持的命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `/help` | 显示帮助信息 | `/help` |
| `/create` | 创建机器人 | `/create` |
| `/info` | 查看机器人信息 | `/info` |
| `/list` | 列出所有机器人 | `/list` |
| `/delete` | 删除机器人 | `/delete` |
| `/update name <名称>` | 更新机器人名称 | `/update name 我的助手` |
| `/update portrait <URL>` | 更新机器人头像 | `/update portrait http://...` |

**智能缓存机制**：
- 自动缓存用户机器人信息，提高响应速度
- 缓存丢失后（如网关重启）自动从 IM 服务器恢复
- 用户数据不会因网关重启而丢失

### 工作流程

1. 用户向 BotFather 机器人**私聊**发送 `/create` 命令
2. Gateway 判断消息目标是否是配置的 botfather 机器人 ID
3. 如果是私聊消息，调用 RobotFatherService 创建机器人
4. 创建时自动使用 `botfather.callbackUrl` 作为回调地址
5. 返回机器人 ID、密钥和网关地址给用户

### 消息路由逻辑

```
IM 服务器推送消息
     ↓
判断是否启用 BotFather
     ↓
判断目标机器人是否是 BotFather
     ↓
┌─────────────────────────────────┐
│  是 BotFather 机器人？          │
└─────────────────────────────────┘
     ↓ 是                    ↓ 否
┌─────────────────────────────────┐
│  是私聊消息？                   │  ← 群聊消息被忽略
└─────────────────────────────────┘
     ↓ 是                    ↓ 否
BotFather 命令处理      忽略消息
     ↓
返回机器人信息给用户
```

### 使用场景

- **私聊（支持）**：用户直接向 BotFather 机器人发送命令，立即得到响应
- **群聊（不支持）**：群聊中的 BotFather 消息会被忽略，即使在群组中 @BotFather 也不会响应

### 功能开关

将 `botfather.enabled` 设为 `false`，所有消息将走原有网关业务，BotFather 功能完全禁用。


## 模块说明

### Gateway (网关服务)
- **功能**：WebSocket网关，支持多机器人动态连接
- **端口**：HTTP 8885, WebSocket 8884
- **配置**：`src/main/resources/application.properties`

### Client SDK (客户端SDK)
- **功能**：机器人客户端SDK，通过WebSocket与网关通信
- **依赖**：Java-WebSocket, Gson, SLF4J
- **输出**：client-1.0.0.jar (包含源码和文档)

### Demo (示例程序)
- **功能**：机器人客户端交互式Demo
- **命令**：send, info, group, profile, status, help, quit
- **输出**：demo-1.0.0.jar (可执行JAR)

## 客户端使用

### Maven依赖

```xml
<dependency>
    <groupId>cn.wildfirechat</groupId>
    <artifactId>client</artifactId>
    <version>1.0.0</version>
</dependency>
```

### 代码示例

```java
import cn.wildfirechat.client.*;
import cn.wildfirechat.client.handler.*;
import cn.wildfirechat.pojos.*;
import cn.wildfirechat.sdk.model.IMResult;

// 1. 创建消息处理器
MessageHandler handler = new MessageHandler() {
    @Override
    public void onMessage(PushMessage message) {
        System.out.println("收到消息: " + message.getData());
    }

    @Override
    public void onConnectionChanged(boolean connected) {
        System.out.println("连接状态: " + connected);
    }

    @Override
    public void onError(String error) {
        System.err.println("错误: " + error);
    }
};

// 2. 创建RobotService客户端
RobotServiceClient robot = new RobotServiceClient(
        "ws://localhost:8884/robot/gateway",
        handler
);

// 3. 连接
boolean success = robot.connect("FireRobot", "123456");
if (!success) {
    System.err.println("鉴权失败");
    return;
}

// 4. 调用机器人API
Conversation conv = new Conversation();
conv.setType(0); // 单聊
conv.setTarget("userId");

MessagePayload payload = new MessagePayload();
payload.setType(1); // 文本消息
payload.setContent("Hello from Robot!");

IMResult<SendMessageResult> result = robot.sendMessage("FireRobot", conv, payload);
if (result.getCode() == 0) {
    System.out.println("发送成功，消息ID: " + result.getResult().getMessageUid());
}

// 5. 关闭连接
robot.close();
```

### 并发请求示例

```java
// 并发调用多个API
List<IMResult<InputOutputUserInfo>> results = userIds.parallelStream()
    .map(userId -> client.getUserInfo(userId))
    .collect(Collectors.toList());
```

## API支持

客户端SDK支持野火IM RobotService的所有方法，包括：

### 消息相关
- `sendMessage` - 发送消息
- `replyMessage` - 回复消息
- `recallMessage` - 撤回消息
- `updateMessage` - 更新消息

### 用户相关
- `getUserInfo` - 获取用户信息
- `getUserInfoByMobile` - 通过手机号获取用户
- `getUserInfoByName` - 通过用户名获取用户
- `applicationGetUserInfo` - 应用获取用户信息

### 群组相关
- `createGroup` - 创建群组
- `getGroupInfo` - 获取群组信息
- `dismissGroup` - 解散群组
- `transferGroup` - 转让群组
- `modifyGroupInfo` - 修改群组信息
- `getGroupMembers` - 获取群成员列表
- `addGroupMembers` - 添加群成员
- `kickoffGroupMembers` - 踢出群成员
- 等等...

### 机器人资料
- `getProfile` - 获取机器人资料
- `updateProfile` - 更新机器人资料

完整API列表请参考：[ARCHITECTURE.md](ARCHITECTURE.md)

## 常见问题

### Q: 打包时提示找不到SDK类
A: 确保 `lib/` 目录下有 `sdk-1.4.3.jar` 和 `common-1.4.3.jar`

### Q: Gateway无法启动
A:
1. 检查端口是否被占用（8885, 8884）
2. 确保IM服务地址配置正确
3. 查看日志错误信息

### Q: Demo无法连接Gateway
A:
1. 确认Gateway已启动
2. 检查防火墙设置
3. 验证机器人凭据是否正确

### Q: 鉴权失败后是否会重连？
A: 不会。首次鉴权失败不会触发重连，需要人工处理。重连后的鉴权失败也不会重连，避免无限重试。

### Q: 支持并发请求吗？
A: 完全支持。客户端SDK使用ConcurrentHashMap和CompletableFuture实现线程安全的并发请求。

### Q: BotFather 功能如何使用？
A:
1. 创建机器人工厂（BotFather）机器人。
2. 在配置文件中设置 `botfather.enabled=true`
3. 配置 BotFather 机器人信息和Server API信息
4. **向 BotFather 机器人私聊发送** `/create` 命令即可创建机器人
5. 详细说明请参考 [BOTFATHER_INTEGRATION.md](BOTFATHER_INTEGRATION.md)

### Q: BotFather 支持群聊吗？
A: **不支持**。BotFather 只支持私聊，群聊中的消息会被忽略。必须在私聊中向 BotFather 机器人发送命令。

### Q: 用户可以自定义机器人的回调地址吗？
A: 不可以。为了安全和管理方便，回调地址由系统统一配置，用户无法通过命令修改。所有创建的机器人都会自动使用配置文件中的 `botfather.callbackUrl`。

### Q: 如何禁用 BotFather 功能？
A: 将配置文件中的 `botfather.enabled` 设为 `false` 即可。禁用后，BotFather 机器人的消息将走原有网关业务。

### Q: BotFather 创建机器人失败怎么办？
A:
1. 检查Server API配置是否正确（`botfather.admin.url` 和 `botfather.admin.secret`）
2. **检查公网地址是否配置**（`botfather.publicAddr` 为必填项）
3. 确认网络连接正常
4. 查看 Gateway 日志中的错误信息
5. 确认 IM 服务器运行正常

### Q: 用户创建机器人后如何连接？
A: 创建机器人后，用户会收到：
- 🆔 机器人ID
- 🔑 密钥
- 🌐 网关地址

用户使用这些信息通过客户端SDK连接网关：
```java
RobotServiceClient robot = new RobotServiceClient(
    "ws://网关地址:8884/robot/gateway",
    handler
);
robot.connect("机器人ID", "密钥");
```

## 技术栈

### 网关服务
- Spring Boot 2.2.10
- Spring WebSocket (Tomcat)
- 野火IM SDK 1.4.3
- Gson

### 客户端
- Java-WebSocket 1.5.3
- Gson 2.8.9
- 野火IM Common SDK 1.4.3

## 更多文档

- [ARCHITECTURE.md](ARCHITECTURE.md) - 详细设计文档，包含架构设计、通信协议、技术实现等
- [BOTFATHER_INTEGRATION.md](BOTFATHER_INTEGRATION.md) - BotFather 功能集成文档，包含自动创建机器人的实现细节
- [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) - OpenClaw 适配器集成文档
- [DSH_INTEGRATION.md](DSH_INTEGRATION.md) - DeepSeek Harness（dsh）集成设计文档

## 许可证
MIT。
