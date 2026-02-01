# 野火IM机器人网关服务

基于WebSocket的野火IM机器人网关服务，提供Java客户端SDK。

## 项目简介

野火IM机器人服务可以通过HTTP双向与IM服务进行沟通，这就要求机器人服务需要部署在IM服务能够直接连接的地址上，通常是在同一个内网，或者机器人服务具有公网IP。

此服务是为了解决这个问题，可以让客户端处在内网中，通过此网关与IM服务进行双向沟通。

```
┌─────────────────┐   WebSocket   ┌─────────────────┐  HTTP/RobotService  ┌──────────────┐
│                 │   :8884       │                 │   :8883             │              │
│  Java客户端      │  ←鉴权+转发→   │     网关服务      │ ←────────────────→  │    IM服务    │
│  (Client SDK)   │               │   (无状态代理)    │                     │              │
│                 │               │                 │                     │              │
├─────────────────┤               ├─────────────────┤                     ├──────────────┤
│ RobotService    │               │ 每个连接动态创建   │                     │              │
│ Client          │               │ RobotService实例 │                     │              │
└─────────────────┘               └─────────────────┘                     └──────────────┘
```

### 特性

- ✅ **多机器人支持**：支持多个机器人同时连接，每个连接独立的RobotService实例
- ✅ **动态鉴权**：客户端连接后动态鉴权，网关不预先配置机器人信息
- ✅ **WebSocket通信**：使用WebSocket长连接，实时双向通信
- ✅ **异步处理**：服务端异步消息处理，支持高并发
- ✅ **心跳保活**：客户端自动心跳（4.5分钟间隔），连接断开自动重连
- ✅ **并发请求**：客户端SDK完全支持并发请求
- ✅ **完整SDK**：提供RobotService的完整Java SDK实现

## 快速开始

### 1. 前置条件

- Java 8 或更高版本
- Maven 3.6 或更高版本
- 野火IM服务已部署

### 2. 准备机器人
创建或者利用现有机器人，得到机器人ID，机器人密钥。另外修改机器人的回调地址，改为网关服务地址。

### 3. 配置网关

编辑 `gateway/src/main/resources/application.properties`：

```properties
# HTTP服务端口（接收IM Webhook）
server.port=8883

# WebSocket服务端口（客户端连接）
websocket.port=8884

# IM服务的实际地址。如果不在同一个服务器上，请正确配置地址，端口默认是80
im.url=http://localhost
```

### 4. 修改Demo中地址
在类```RobotClientDemo```中，修改机器人ID，机器人密钥和网关地址。

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


### 4. 启动网关服务
把gateway-1.0.0.jar上传到网关服务，执行启动命令：

```bash
java -jar gateway/target/gateway-1.0.0.jar
```

启动后：
- 监听HTTP 8883端口，等待IM服务的回调。
- 监听WebSocket 8884端口，等待客户端的websocket连入。

防火墙：
- 公网放开8884的入访权限。
- 开通与IM服务8883的入访权限。
- 开通与IM服务80端口的出访权限。

### 5. 运行Demo
在客户端本地，或者其他地方，运行如下命令：

```bash
java -jar demo/target/demo-1.0.0.jar
```

Demo会自动连接到Gateway并使用机器人账号登录。

Demo交互命令：
```
send <userId> <text>    - 发送消息
info <userId>             - 获取用户信息
group                     - 创建群组
profile                   - 获取机器人资料
status                    - 查看连接状态
help                      - 显示帮助
quit                      - 退出程序
```

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

## 配置说明

### 网关配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| server.port | HTTP服务端口 | 8883 |
| websocket.port | WebSocket服务端口 | 8884 |
| im.url | IM服务地址 | http://localhost |

### 客户端配置

客户端无需配置文件，连接时传入网关地址即可：

```java
ConnectionManager manager = new ConnectionManager(
    "ws://your-gateway:8884/robot/gateway",
    handler
);
```

连接参数：
- **心跳间隔**：270秒（4.5分钟）
- **重连间隔**：5秒
- **请求超时**：30秒

## 部署指南

### 生产环境部署

```bash
# 1. 创建部署目录
mkdir -p /opt/robot-gateway
cd /opt/robot-gateway

# 2. 复制jar包
cp gateway/target/gateway-1.0.0.jar .

# 3. 创建配置文件
mkdir -p config
cat > config/application.properties << EOF
server.port=8883
websocket.port=8884
im.url=http://your-im-server
EOF

# 4. 启动服务
java -Xms512m -Xmx2g \
     -XX:+UseG1GC \
     -jar gateway-1.0.0.jar \
     --spring.config.location=file:config/application.properties
```

### 使用Systemd管理

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

### 健康检查

```bash
# 检查HTTP端口
curl http://localhost:8883/actuator/health

# 检查WebSocket端口（需要安装wscat）
wscat -c ws://localhost:8884/robot/gateway
```

## 模块说明

### Gateway (网关服务)
- **功能**：WebSocket网关，支持多机器人动态连接
- **端口**：HTTP 8883, WebSocket 8884
- **配置**：`src/main/resources/application.properties`

### Client SDK (客户端SDK)
- **功能**：机器人客户端SDK，通过WebSocket与网关通信
- **依赖**：Java-WebSocket, Gson, SLF4J
- **输出**：client-1.0.0.jar (包含源码和文档)

### Demo (示例程序)
- **功能**：机器人客户端交互式Demo
- **命令**：send, info, group, profile, status, help, quit
- **输出**：demo-1.0.0.jar (可执行JAR)

## 常见问题

### Q: 打包时提示找不到SDK类
A: 确保 `lib/` 目录下有 `sdk-1.4.2.jar` 和 `common-1.4.2.jar`

### Q: Gateway无法启动
A:
1. 检查端口是否被占用（8883, 8884）
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

## 技术栈

### 网关服务
- Spring Boot 2.2.10
- Spring WebSocket (Tomcat)
- 野火IM SDK 1.4.2
- Gson

### 客户端
- Java-WebSocket 1.5.3
- Gson 2.8.9
- 野火IM Common SDK 1.4.2

## 更多文档

- [ARCHITECTURE.md](ARCHITECTURE.md) - 详细设计文档，包含架构设计、通信协议、技术实现等

## 许可证
MIT。
