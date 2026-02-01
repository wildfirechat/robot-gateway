# 野火IM机器人网关服务 - 详细设计文档

## 目录

1. [系统架构](#系统架构)
2. [通信协议](#通信协议)
3. [鉴权机制](#鉴权机制)
4. [消息处理流程](#消息处理流程)
5. [心跳机制](#心跳机制)
6. [并发处理](#并发处理)
7. [会话管理](#会话管理)
8. [错误处理](#错误处理)
9. [项目结构](#项目结构)
10. [技术实现细节](#技术实现细节)

## 系统架构

### 整体架构图

```
┌─────────────────┐  WebSocket    ┌─────────────────┐  HTTP/RobotService  ┌──────────────┐
│                 │  :8884        │                 │   :8883             │              │
│   Java客户端     │ ←鉴权+转发→    │    网关服务       │ ←────────────────→  │    IM服务     │
│  (Client SDK)   │               │   (无状态代理)    │                     │              │
│                 │               │                 │                     │              │
├─────────────────┤               ├─────────────────┤                     ├──────────────┤
│ RobotService    │               │ 每个连接动态创建 │                       │              │
│ Client          │               │ RobotService实例 │                     │              │
└─────────────────┘               └─────────────────┘                     └──────────────┘
```

### 设计原则

1. **无状态代理**：网关不保存机器人信息，每个WebSocket会话动态创建RobotService实例
2. **动态鉴权**：客户端连接后必须先鉴权，鉴权通过后才能发送请求
3. **异步处理**：使用@Async注解实现异步消息处理，避免阻塞IO线程
4. **线程安全**：使用ConcurrentHashMap保证并发安全
5. **自动重连**：客户端断线自动重连，重连后自动重新鉴权

## 通信协议

### 连接方式

- **协议**：WebSocket (RFC 6455)
- **端点**：`ws://gateway:8884/robot/gateway`
- **消息格式**：JSON

### 消息类型

#### 1. 鉴权消息 (ConnectMessage)

**客户端 → 网关（鉴权请求）**：
```json
{
  "type": "connect",
  "robotId": "FireRobot",
  "secret": "123456"
}
```

**网关 → 客户端（鉴权成功）**：
```json
{
  "type": "connect",
  "code": 0,
  "msg": "success"
}
```

**网关 → 客户端（鉴权失败）**：
```json
{
  "type": "connect",
  "code": 401,
  "msg": "Authentication failed: invalid robot secret"
}
```

#### 2. 请求消息 (RequestMessage)

**客户端 → 网关**：
```json
{
  "requestId": "uuid-1234-5678",
  "method": "sendMessage",
  "params": [
    "fromUser",
    {"type": 1, "target": "userId", "line": 0},
    {"type": 1, "content": "Hello"}
  ]
}
```

字段说明：
- `requestId`：唯一请求ID，用于关联响应（UUID格式）
- `method`：方法名，对应RobotService的方法
- `params`：参数数组，与方法签名对应

#### 3. 响应消息 (ResponseMessage)

**网关 → 客户端**：
```json
{
  "requestId": "uuid-1234-5678",
  "code": 0,
  "msg": "success",
  "result": {
    "messageId": 12345,
    "timestamp": 1640000000000
  }
}
```

字段说明：
- `requestId`：对应的请求ID
- `code`：状态码，0表示成功
- `msg`：消息描述
- `result`：返回结果（方法返回值）

#### 4. 推送消息 (PushMessage)

**网关 → 客户端**：
```json
{
  "type": "message",
  "data": {
    "sender": "userId",
    "conv": {
      "type": 1,
      "target": "robotId",
      "line": 0
    },
    "payload": {
      "type": 1,
      "content": "Hello Robot"
    },
    "fromUser": "userId",
    "timestamp": 1640000000000
  }
}
```

## 鉴权机制

### 鉴权流程

```
客户端                          网关                          IM服务
   │                              │                              │
   │  1. WebSocket连接(:8884)      │                              │
   │─────────────────────────────>│                              │
   │                              │                              │
   │ 2. connect(robotId, secret)  │                              │
   │─────────────────────────────>│                              │
   │                              │  3. getProfile(robotId)      │
   │                              │─────────────────────────────>│
   │                              │                              │
   │                              │  4. 返回机器人资料             │
   │                              │<─────────────────────────────│
   │                              │                              │
   │                              │  5. 验证secret               │
   │                              │  6. 创建RobotService实例      │
   │                              │  7. 绑定到会话                │
   │                              │                              │
   │  8. connect响应(code: 0)      │                              │
   │<───────────────────────────-─│                              │
   │  (鉴权成功，可以发送请求)       │                               │
```

### 鉴权实现

**网关端**（`AuthHandler.java`）：
```java
public AuthResult authenticateWithResult(String robotId, String secret) {
    try {
        // 调用IM服务获取机器人资料
        IMResult<OutputRobot> result = robotService.getProfile(robotId);

        if (result.getCode() != 0) {
            return AuthResult.fail(404, "Robot not found");
        }

        OutputRobot robot = result.getResult();

        // 验证secret
        if (!robot.getSecret().equals(secret)) {
            return AuthResult.fail(401, "Authentication failed: invalid robot secret");
        }

        // 创建RobotService实例
        RobotService robotService = new RobotService(
            imUrl, robotId, secret
        );

        return AuthResult.success(robotService);

    } catch (Exception e) {
        return AuthResult.fail(500, "Internal error: " + e.getMessage());
    }
}
```

**客户端**（`ConnectionManager.java`）：
```java
public boolean connect(String robotId, String secret, long timeoutSeconds) {
    // 1. 建立WebSocket连接
    start();

    // 2. 等待连接建立
    while (!connected && running) {
        Thread.sleep(100);
        if (超时) return false;
    }

    // 3. 发送鉴权请求
    CompletableFuture<Boolean> authFuture = new CompletableFuture<>();
    client.sendConnect(robotId, secret, authFuture);

    // 4. 等待鉴权结果
    boolean result = authFuture.get(timeoutSeconds, TimeUnit.SECONDS);

    // 5. 只有鉴权成功才保存凭据（用于重连）
    if (result) {
        this.robotId = robotId;
        this.robotSecret = secret;
    }

    return result;
}
```

### 鉴权失败处理

**首次鉴权失败**：
- 不保存robotId和robotSecret
- 停止运行，不触发重连
- 需要人工处理

**重连后鉴权失败**：
- 清空已保存的robotId和robotSecret
- 停止运行，不再重连
- 避免无限重试

## 消息处理流程

### API调用流程（客户端 → IM）

```
客户端                    网关                     IM服务
   │                       │                        │
   │  1. sendMessage(...)  │                        │
   │──────────────────────>│                        │
   │  RequestMessage       │                        │
   │                       │                        │
   │                       │  2. 获取会话的           │
   │                       │     RobotService       │
   │                       │  3. 反射调用方法         │
   │                       │───────────────────────>│
   │                       │  4. 返回结果            │
   │                       │<───────────────────────│
   │                       │                        │
   │  5. ResponseMessage   │                        │
   │<──────────────────────│                        │
```

### 消息推送流程（IM → 客户端）

```
IM服务                    网关                    客户端
   │                       │                        │
   │  1. 用户发送消息给机器人  │                        │
   │                       │                        │
   │  2. HTTP Webhook      │                        │
   │  POST /robot/recvmsg  │                        │
   │──────────────────────>│                        │
   │  {robotId, message}   │                        │
   │                       │                        │
   │                       │  3. 查找robotId对应的    │
   │                       │     WebSocket会话       │
   │                       │  4. 推送PushMessage     │
   │                       │───────────────────────>│
   │                       │                        │
   │  5. 返回200 OK         │                        │
   │<──────────────────────│                        │
```

## 心跳机制

### 设计目的

1. **连接保活**：防止长时间无数据交换导致连接断开
2. **状态检测**：及时发现连接异常
3. **负载均衡友好**：避免某些负载均衡器关闭空闲连接

### 心跳参数

- **心跳间隔**：270秒（4.5分钟）
- **心跳方式**：客户端主动发送心跳请求
- **服务端处理**：更新会话的最后心跳时间

### 客户端心跳实现

**定时发送**（`ConnectionManager.java`）：
```java
private void startHeartbeat() {
    heartbeatExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "HeartbeatThread");
        thread.setDaemon(true);
        return thread;
    });

    // 每270秒发送一次心跳
    heartbeatExecutor.scheduleAtFixedRate(() -> {
        if (authenticated && client.isOpen()) {
            sendHeartbeat();
        }
    }, heartbeatInterval, heartbeatInterval, TimeUnit.MILLISECONDS);
}

private void sendHeartbeat() {
    Map<String, Object> heartbeat = new HashMap<>();
    heartbeat.put("type", "heartbeat");
    heartbeat.put("timestamp", System.currentTimeMillis());

    // 发送心跳请求
    CompletableFuture<ResponseMessage> future = client.sendRequest("heartbeat", null);
    lastHeartbeatTime = System.currentTimeMillis();
}
```

### 服务端心跳处理

**心跳处理**（`RobotGatewayEndpoint.java`）：
```java
private void handleHeartbeat(WebSocketSession session, RequestMessage request) {
    String sessionId = session.getId();
    String robotId = sessionManager.getRobotIdBySession(sessionId);

    // 更新心跳时间
    sessionManager.updateHeartbeatTime(sessionId);

    // 返回心跳响应
    ResponseMessage response = ResponseMessage.success(
        request.getRequestId(),
        System.currentTimeMillis()
    );
    sessionManager.sendMessage(session, response);

    LOG.debug("Heartbeat received from robot {}: {}", robotId, sessionId);
}
```

**心跳时间跟踪**（`SessionManager.java`）：
```java
public static class SessionInfo {
    private volatile long lastHeartbeatTime;

    public SessionInfo(String sessionId) {
        this.lastHeartbeatTime = System.currentTimeMillis();
    }

    public void updateHeartbeatTime() {
        this.lastHeartbeatTime = System.currentTimeMillis();
    }

    public long getLastHeartbeatTime() {
        return lastHeartbeatTime;
    }
}
```

## 并发处理

### 服务端异步处理

**问题**：Spring WebSocket的`handleTextMessage`默认在IO线程同步执行，导致：
1. 阻塞IO线程，无法接收新消息
2. 性能问题，无法充分利用多核CPU
3. 连接超时，长时间处理可能导致客户端超时

**解决方案**：使用`@Async`注解

**配置**（`ExecutorConfig.java`）：
```java
@Configuration
@EnableAsync(proxyTargetClass = true)  // 使用CGLib代理
public class ExecutorConfig {

    @Bean
    public Executor asyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(10);
        executor.setMaxPoolSize(10);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("gateway-async-");
        executor.initialize();
        return executor;
    }
}
```

**使用**（`RobotGatewayEndpoint.java`）：
```java
@Override
@Async("asyncExecutor")  // 使用异步线程池处理消息
protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    // 消息处理逻辑在独立线程池中执行
    // IO线程立即释放，可接收新消息

    RequestMessage request = gson.fromJson(payload, RequestMessage.class);

    // 处理请求
    ResponseMessage response = robotProxy.handleRequest(session, request);

    // 发送响应（WebSocketSession是线程安全的）
    sessionManager.sendMessage(session, response);
}
```

**性能对比**：

| 场景 | 同步处理 | 异步处理 |
|------|---------|---------|
| 并发连接数 | 10 | 100+ |
| 消息吞吐量 | ~100 msg/s | ~1000+ msg/s |
| 平均响应时间 | 取决于最慢请求 | 可并行处理 |
| 阻塞风险 | 高 | 低 |

### 客户端并发请求

**实现**：使用`ConcurrentHashMap`和`CompletableFuture`

**请求注册**（`ResponseHandler.java`）：
```java
// 线程安全的请求存储
private final Map<String, CompletableFuture<ResponseMessage>> pendingRequests =
    new ConcurrentHashMap<>();

public CompletableFuture<ResponseMessage> registerRequest(String requestId) {
    CompletableFuture<ResponseMessage> future = new CompletableFuture<>();
    pendingRequests.put(requestId, future);  // 线程安全

    // 设置超时
    scheduler.schedule(() -> {
        CompletableFuture<ResponseMessage> f = pendingRequests.remove(requestId);
        if (f != null && !f.isDone()) {
            f.completeExceptionally(new TimeoutException("Request timeout"));
        }
    }, timeout, TimeUnit.SECONDS);

    return future;
}
```

**并发请求示例**：
```java
// 10个线程并发请求
ExecutorService executor = Executors.newFixedThreadPool(10);

List<CompletableFuture<IMResult<InputOutputUserInfo>>> futures = new ArrayList<>();
for (String userId : userIds) {
    CompletableFuture<IMResult<InputOutputUserInfo>> future =
        CompletableFuture.supplyAsync(() -> client.getUserInfo(userId), executor);
    futures.add(future);
}

// 等待所有请求完成
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
```

**性能对比**：

| 场景 | 顺序执行 | 并发执行（10线程） |
|------|---------|---------------|
| 10个用户信息查询 | ~5秒 | ~0.5秒 |
| 100个消息发送 | ~50秒 | ~5秒 |
| 混合读写操作 | 可变 | 显著提升 |

## 会话管理

### 会话信息

**SessionInfo**（`SessionManager.java`）：
```java
public static class SessionInfo {
    private final String sessionId;
    private String robotId;
    private RobotService robotService;  // 每个会话独立的RobotService实例
    private volatile long lastHeartbeatTime;

    public SessionInfo(String sessionId) {
        this.sessionId = sessionId;
        this.lastHeartbeatTime = System.currentTimeMillis();
    }

    // 鉴权成功后设置
    public void authenticate(String robotId, RobotService robotService) {
        this.robotId = robotId;
        this.robotService = robotService;
    }

    public boolean isAuthenticated() {
        return robotId != null && robotService != null;
    }
}
```

### 会话生命周期

```
连接建立 → 未鉴权状态 → 鉴权成功 → 已鉴权状态 → 处理请求/推送消息
   ↓           ↓             ↓           ↓              ↓
连接断开   超时断开       鉴权失败    连接断开      会话清理
```

### 会话操作

**添加会话**（连接建立时）：
```java
public void addSession(WebSocketSession session) {
    String sessionId = session.getId();
    sessions.put(sessionId, session);
    sessionInfos.put(sessionId, new SessionInfo(sessionId));
    LOG.info("Session added: {}", sessionId);
}
```

**鉴权会话**：
```java
public void authenticateSession(String sessionId, String robotId, RobotService robotService) {
    SessionInfo info = sessionInfos.get(sessionId);
    if (info != null) {
        info.authenticate(robotId, robotService);
        robotIdToSessionIdMap.put(robotId, sessionId);  // 用于消息推送
        LOG.info("Session authenticated: {} as robot {}", sessionId, robotId);
    }
}
```

**移除会话**（连接断开时）：
```java
public void removeSession(WebSocketSession session) {
    String sessionId = session.getId();
    SessionInfo info = sessionInfos.get(sessionId);

    if (info != null && info.getRobotId() != null) {
        robotIdToSessionIdMap.remove(info.getRobotId());
    }

    sessions.remove(sessionId);
    sessionInfos.remove(sessionId);
    LOG.info("Session removed: {}", sessionId);
}
```

## 错误处理

### 错误码定义

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 400 | 请求格式错误 |
| 401 | 未鉴权或鉴权失败 |
| 404 | 机器人不存在 |
| 500 | 服务器内部错误 |

### 错误响应格式

```json
{
  "requestId": "uuid",
  "code": 400,
  "msg": "Invalid request format: requestId and method are required",
  "result": null
}
```

### 客户端错误处理

**超时处理**：
```java
public CompletableFuture<ResponseMessage> registerRequest(String requestId) {
    CompletableFuture<ResponseMessage> future = new CompletableFuture<>();
    pendingRequests.put(requestId, future);

    // 设置超时
    scheduler.schedule(() -> {
        CompletableFuture<ResponseMessage> f = pendingRequests.remove(requestId);
        if (f != null && !f.isDone()) {
            f.completeExceptionally(new TimeoutException("Request timeout"));
        }
    }, timeout, TimeUnit.SECONDS);

    return future;
}
```

**使用方捕获异常**：
```java
try {
    IMResult<OutputRobot> result = client.getProfile();
    // 处理成功
} catch (CompletionException e) {
    Throwable cause = e.getCause();
    if (cause instanceof TimeoutException) {
        LOG.error("Request timeout");
    } else if (cause instanceof ExecutionException) {
        LOG.error("Execution error: {}", cause.getCause().getMessage());
    }
}
```

### 服务端错误处理

**统一异常处理**（`RobotGatewayEndpoint.java`）：
```java
@Override
@Async("asyncExecutor")
protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    try {
        // 处理消息
    } catch (JsonSyntaxException e) {
        LOG.error("Failed to parse message: {}", e.getMessage());
        ConnectMessage error = ConnectMessage.error(400, "Invalid JSON format");
        sessionManager.sendMessage(session, error);
    } catch (Exception e) {
        LOG.error("Failed to handle message: {}", e.getMessage(), e);
        ConnectMessage error = ConnectMessage.error(500, "Internal server error");
        sessionManager.sendMessage(session, error);
    }
}
```

## 项目结构

### 整体结构

```
robot_server/
├── pom.xml                     # 父POM
├── gateway/                    # 网关服务模块
│   ├── pom.xml
│   └── src/main/java/cn/wildfirechat/app/
│       ├── Application.java                # 启动类
│       ├── ExecutorConfig.java             # 异步线程池配置
│       ├── RobotConfig.java                # 配置类
│       ├── Controller.java                 # HTTP Webhook接收器
│       ├── Service.java                    # 服务接口
│       ├── ServiceImpl.java                # 消息分发服务
│       ├── config/
│       │   └── WebSocketConfig.java        # WebSocket配置
│       ├── gateway/
│       │   ├── RobotGatewayEndpoint.java   # WebSocket端点
│       │   ├── SessionManager.java         # 会话管理器
│       │   ├── RobotProxy.java             # 请求代理
│       │   └── AuthHandler.java            # 鉴权处理器
│       └── protocol/
│           ├── RequestMessage.java         # 请求消息
│           ├── ResponseMessage.java        # 响应消息
│           ├── PushMessage.java            # 推送消息
│           └── ConnectMessage.java         # 鉴权消息
│
├── client/                     # 客户端SDK模块
│   ├── pom.xml
│   └── src/main/java/cn/wildfirechat/client/
│       ├── ConnectionManager.java          # 连接管理器
│       ├── RobotGatewayClient.java         # WebSocket客户端
│       ├── RobotServiceClient.java         # RobotService客户端实现
│       ├── protocol/
│       │   ├── RequestMessage.java         # 请求消息
│       │   ├── ResponseMessage.java        # 响应消息
│       │   ├── PushMessage.java            # 推送消息
│       │   └── ConnectMessage.java         # 鉴权消息
│       └── handler/
│           ├── MessageHandler.java         # 消息处理器接口
│           └── ResponseHandler.java        # 响应处理器
│
└── demo/                       # 示例程序模块
    ├── pom.xml
    └── src/main/java/cn/wildfirechat/demo/
        └── RobotClientDemo.java            # 交互式Demo
```

### 核心类说明

#### 网关服务

| 类名 | 职责 |
|------|------|
| Application | Spring Boot启动类 |
| ExecutorConfig | 配置异步线程池 |
| WebSocketConfig | 配置WebSocket端点和端口 |
| RobotGatewayEndpoint | WebSocket连接处理、消息分发 |
| SessionManager | 管理所有WebSocket会话 |
| RobotProxy | 代理客户端请求到RobotService SDK |
| AuthHandler | 处理机器人鉴权 |
| Controller | 接收IM服务Webhook推送 |

#### 客户端SDK

| 类名 | 职责 |
|------|------|
| ConnectionManager | 管理WebSocket连接生命周期 |
| RobotGatewayClient | WebSocket客户端封装 |
| RobotServiceClient | 实现RobotService的所有方法 |
| ResponseHandler | 处理响应、超时管理 |
| MessageHandler | 消息回调接口 |

## 技术实现细节

### 1. 请求代理实现

使用Java反射动态调用RobotService方法：

**RobotProxy.java**：
```java
public ResponseMessage handleRequest(WebSocketSession session, RequestMessage request) {
    String sessionId = session.getId();

    // 获取会话对应的RobotService实例
    RobotService robotService = sessionManager.getRobotService(sessionId);
    if (robotService == null) {
        return ResponseMessage.error(request.getRequestId(), 401, "Not authenticated");
    }

    String method = request.getMethod();
    List<Object> params = request.getParams();

    try {
        // 获取方法
        Method targetMethod = findMethod(robotService.getClass(), method, params.size());

        // 调用方法
        Object result = targetMethod.invoke(robotService, params.toArray());

        // 返回结果
        return ResponseMessage.success(request.getRequestId(), result);

    } catch (Exception e) {
        LOG.error("Failed to invoke method {}: {}", method, e.getMessage());
        return ResponseMessage.error(request.getRequestId(), 500, e.getMessage());
    }
}

private Method findMethod(Class<?> clazz, String methodName, int paramCount) {
    for (Method method : clazz.getMethods()) {
        if (method.getName().equals(methodName) &&
            method.getParameterCount() == paramCount) {
            return method;
        }
    }
    throw new IllegalArgumentException("Method not found: " + methodName);
}
```

### 2. 请求-响应匹配

使用ConcurrentHashMap和UUID实现：

**客户端**：
```java
// 生成唯一请求ID
String requestId = UUID.randomUUID().toString();

// 注册等待响应的Future
CompletableFuture<ResponseMessage> future = responseHandler.registerRequest(requestId);

// 发送请求
RequestMessage request = new RequestMessage(requestId, method, params);
send(gson.toJson(request));

// 等待响应（阻塞等待）
ResponseMessage response = future.get();
```

**服务端**：
```java
// 解析请求
RequestMessage request = gson.fromJson(payload, RequestMessage.class);
String requestId = request.getRequestId();

// 处理请求
Object result = invokeMethod(request.getMethod(), request.getParams());

// 返回响应（使用相同的requestId）
ResponseMessage response = new ResponseMessage(requestId, 0, "success", result);
sendMessage(session, response);
```

### 3. 消息推送路由

通过robotId查找对应的WebSocket会话：

**Controller.java**（接收Webhook）：
```java
@PostMapping("/robot/recvmsg")
public ResponseMessage handleRecvMsg(@RequestBody Map<String, Object> body) {
    String robotId = (String) body.get("robot_id");
    Map<String, Object> messageData = (Map<String, Object>) body.get("message");

    // 查找robotId对应的会话
    WebSocketSession session = sessionManager.getSessionByRobotId(robotId);

    if (session != null && session.isOpen()) {
        // 转换为PushMessage
        PushMessage pushMessage = PushMessage.message(messageData);

        // 推送给客户端
        sessionManager.sendMessage(session, pushMessage);

        return ResponseMessage.success();
    } else {
        LOG.warn("No active session for robot: {}", robotId);
        return ResponseMessage.error(404, "Robot not connected");
    }
}
```

**SessionManager.java**（会话查找）：
```java
private final Map<String, String> robotIdToSessionIdMap = new ConcurrentHashMap<>();

public void authenticateSession(String sessionId, String robotId, RobotService robotService) {
    SessionInfo info = sessionInfos.get(sessionId);
    if (info != null) {
        info.authenticate(robotId, robotService);
        robotIdToSessionIdMap.put(robotId, sessionId);  // 建立映射
    }
}

public WebSocketSession getSessionByRobotId(String robotId) {
    String sessionId = robotIdToSessionIdMap.get(robotId);
    return sessions.get(sessionId);
}
```

### 4. 双端口配置

使用额外的TomcatConnector实现WebSocket独立端口：

**WebSocketConfig.java**：
```java
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    @Value("${websocket.port:8884}")
    private int websocketPort;

    @Autowired
    private RobotGatewayEndpoint robotGatewayEndpoint;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(robotGatewayEndpoint, "/robot/gateway")
                .setAllowedOrigins("*");
    }

    @Bean
    public ServletWebServerFactory servletContainer() {
        TomcatServletWebServerFactory tomcat = new TomcatServletWebServerFactory();
        tomcat.addAdditionalTomcatConnectors(createWebSocketConnector());
        return tomcat;
    }

    private Connector createWebSocketConnector() {
        Connector connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
        Http11NioProtocol protocol = (Http11NioProtocol) connector.getProtocolHandler();
        connector.setPort(websocketPort);
        return connector;
    }
}
```

### 5. 线程安全保证

**WebSocketSession线程安全**：
- `sendMessage()`方法是线程安全的
- 可以在异步线程中调用

**ConcurrentHashMap使用**：
```java
// 服务端：会话存储
private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
private final Map<String, SessionInfo> sessionInfos = new ConcurrentHashMap<>();
private final Map<String, String> robotIdToSessionIdMap = new ConcurrentHashMap<>();

// 客户端：请求存储
private final Map<String, CompletableFuture<ResponseMessage>> pendingRequests =
    new ConcurrentHashMap<>();
```

**volatile关键字使用**：
```java
// ConnectionManager.java
private volatile boolean running = false;
private volatile boolean connected = false;
private volatile boolean authenticated = false;
private volatile String robotId;
private volatile String robotSecret;
```

### 6. 重连机制

**触发条件**：
- 连接断开
- 网络异常

**重连流程**：
```java
public void onDisconnected() {
    boolean wasAuthenticated = authenticated;
    connected = false;
    authenticated = false;

    if (wasAuthenticated && messageHandler != null) {
        messageHandler.onConnectionChanged(false);
    }

    // 只有有鉴权信息且正在运行时才重连
    if (running && robotId != null && robotSecret != null) {
        scheduleReconnect();
    }
}

private void scheduleReconnect() {
    if (!running) return;

    LOG.info("Scheduling reconnect in {} ms", reconnectInterval);

    new Thread(() -> {
        try {
            Thread.sleep(reconnectInterval);
            if (running && !connected) {
                reconnect();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }, "ReconnectThread").start();
}

public void onConnected() {
    connected = true;

    // 如果有保存的鉴权信息，自动重新鉴权
    if (robotId != null && robotSecret != null && !authenticated) {
        new Thread(() -> {
            try {
                CompletableFuture<Boolean> authFuture = new CompletableFuture<>();
                client.sendConnect(robotId, robotSecret, authFuture);

                Boolean result = authFuture.get(30, TimeUnit.SECONDS);
                if (!result) {
                    // 重连鉴权失败，清空凭据，避免无限重试
                    robotId = null;
                    robotSecret = null;
                }
            } catch (Exception e) {
                LOG.error("Auto re-authentication error: {}", e.getMessage());
                robotId = null;
                robotSecret = null;
            }
        }, "ReAuthThread").start();
    }
}
```

## API完整列表

客户端SDK `RobotServiceClient` 支持以下方法（与野火IM RobotService完全一致）：

### 消息相关
- `sendMessage(String fromUser, Conversation conversation, MessagePayload payload)`
- `replyMessage(String fromUser, OutputMessageData message, MessagePayload payload)`
- `recallMessage(String fromUser, long messageId)`
- `updateMessage(String fromUser, long messageId, MessagePayload payload)`

### 用户相关
- `getUserInfo(String userId)`
- `getUserInfoByMobile(String mobile, String areaCode)`
- `getUserInfoByName(String name)`
- `applicationGetUserInfo(String applicationId, String userId)`

### 群组相关（需要额外参数）
- `createGroup(PojoGroupInfo groupInfo, List<PojoGroupMember> members, String to, List<Integer> lines, MessagePayload payload)`
- `getGroupInfo(String groupId, long updateDt)`
- `dismissGroup(String groupId)`
- `transferGroup(String groupId, String newOwner)`
- `modifyGroupInfo(String groupId, int modifyType, String value)`
- `getGroupMembers(String groupId, long updateDt)`
- `getGroupMember(String groupId, String userId)`
- `addGroupMembers(String groupId, List<PojoGroupMember> members, String to, List<Integer> lines, MessagePayload payload)`
- `kickoffGroupMembers(String groupId, List<String> members, String to, List<Integer> lines, MessagePayload payload)`
- `quitGroup(String groupId, String to, List<Integer> lines, MessagePayload payload)`
- `setGroupManager(String groupId, List<String> managers, int type)`
- `muteGroupMember(String groupId, List<String> members, int type, long time)`
- `allowGroupMember(String groupId, List<String> members, int type)`
- `setGroupMemberAlias(String groupId, String userId, String alias)`
- `setGroupMemberExtra(String groupId, String userId, String extra)`

### 机器人资料
- `getProfile()`
- `updateProfile(int type, String value)`

### 回调相关
- `setCallback(String callbackUrl, int mediaType)`
- `getCallback()`
- `deleteCallback()`

### 会议相关
- `sendConferenceRequest(String roomId, String callId, String host, long startTime, String title, String pin, boolean record)`

### 动态圈相关
- `postMomentsFeed(String to, List<Integer> lines, MessagePayload payload)`
- `updateMomentsFeed(String feedId, String to, List<Integer> lines, MessagePayload payload)`
- `deleteMomentsFeed(String feedId)`
- `getMomentsFeed(String feedId, int count, long fromFeedIdInServer, int type)`
- `getUserMomentsFeeds(String user, int count, long fromFeedIdInServer, int type)`
- `getFriendsMomentsFeeds(int count, long fromFeedIdInServer, int type)`
- `commentMomentsFeed(String feedId, String toUser, String commentType, String toCommentId, List<Integer> lines, MessagePayload payload)`
- `deleteMomentsComment(String feedId, String commentId)`
- `likeMomentsFeed(String feedId, String toUser, int likeType)`
- `getMomentsComments(String feedId, String user, int count, long fromCommentIdInServer)`
- `getMomentsLikes(String feedId, int count, long fromLikeIdInServer)`
- `getMomentsStatistics(String feedId)`

---

**文档版本**：1.0
**最后更新**：2026-02-01
