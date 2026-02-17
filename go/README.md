# 野火IM机器人网关 Go 版本

这是野火IM机器人网关服务的Go语言实现，包含SDK和OpenClaw适配器。

## 项目结构

```
go/
├── go.work                      # Go workspace
├── sdk/                         # 客户端SDK
│   ├── go.mod
│   ├── protocol/                # 协议定义
│   │   ├── types.go            # 基本类型（消息、会话等）
│   │   └── imresult.go         # IM结果类型
│   ├── client/                  # 客户端实现
│   │   ├── handler.go          # 消息处理器接口
│   │   ├── response_handler.go # 响应处理器
│   │   ├── websocket_client.go # WebSocket客户端
│   │   ├── connection_manager.go # 连接管理器
│   │   └── robot_service_client.go # RobotService客户端
│   └── example/                 # SDK使用示例
│       └── main.go
└── openclaw-adapter/            # OpenClaw适配器
    ├── go.mod
    ├── cmd/
    │   └── main.go             # 程序入口
    ├── config.example.yaml     # 示例配置文件
    └── internal/
        ├── config/             # 配置管理
        ├── openclaw/           # OpenClaw客户端
        ├── converter/          # 消息格式转换器
        ├── filter/             # 过滤器（群聊策略、白名单）
        ├── session/            # 会话管理
        └── bridge/             # 桥接器
```

## SDK 使用说明

### 安装

```bash
cd go/sdk
go mod tidy
```

### 基本使用

```go
package main

import (
    "github.com/wildfirechat/robot-gateway-sdk/client"
    "github.com/wildfirechat/robot-gateway-sdk/protocol"
)

// 实现消息处理器
type MyMessageHandler struct{}

func (h *MyMessageHandler) OnMessage(message *protocol.PushMessage) {
    // 处理收到的消息
    println("Received:", message.Data.Payload.SearchableContent)
}

func (h *MyMessageHandler) OnConnectionChanged(connected bool) {
    println("Connection changed:", connected)
}

func (h *MyMessageHandler) OnError(error string) {
    println("Error:", error)
}

func main() {
    // 创建客户端
    handler := &MyMessageHandler{}
    robot := client.NewRobotServiceClient(
        "ws://localhost:8884/robot/gateway",
        handler,
    )

    // 连接并鉴权
    if !robot.Connect("RobotID", "RobotSecret") {
        panic("Failed to connect")
    }

    // 发送消息
    conv := &protocol.Conversation{
        Type:   0, // 单聊
        Target: "userId",
        Line:   0,
    }
    
    payload := &protocol.MessagePayload{
        Type:              1, // 文本消息
        SearchableContent: "Hello from Go!",
    }
    
    result, err := robot.SendMessage(conv, payload)
    if err == nil && result.IsSuccess() {
        println("Message sent! UID:", result.Result.MessageUID)
    }

    // 获取用户信息
    userResult, _ := robot.GetUserInfo("userId")
    if userResult.IsSuccess() {
        println("User:", userResult.Result.DisplayName)
    }

    // 保持运行...
    select {}
}
```

### 运行示例

```bash
cd go/sdk/example
go run main.go ws://localhost:8884/robot/gateway YourRobotId YourRobotSecret
```

## OpenClaw 适配器

OpenClaw适配器将野火IM与OpenClaw Gateway连接起来，实现AI对话功能。

### 配置

复制示例配置文件并修改：

```bash
cd go/openclaw-adapter
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入你的配置
```

配置文件说明：

```yaml
# 野火网关配置
wildfire:
  gateway_url: "ws://localhost:8884/robot/gateway"
  robot_id: "YourRobotId"
  robot_secret: "YourRobotSecret"

# OpenClaw网关配置
openclaw:
  url: "ws://127.0.0.1:18789"
  token: ""
  scope: "wildfire-im"

# 群聊策略配置
group:
  enabled: true
  respond_on_mention: true      # 被@时回复
  respond_on_question: true     # 问号结尾时回复
  help_keywords: ["帮", "请", "分析", "总结", "怎么", "如何"]

# 白名单配置
whitelist:
  enabled: false
  allowed_senders: []
  blocked_senders: []
```

### 运行

```bash
cd go/openclaw-adapter
go run cmd/main.go
```

或使用配置文件：

```bash
go run cmd/main.go --config /path/to/config.yaml
```

### API 端点

- `GET /health` - 健康检查
- `GET /sessions` - 会话统计
- `GET /` - 状态页面

## 特性

### SDK 特性

- ✅ WebSocket 连接管理
- ✅ 自动鉴权和重连
- ✅ 心跳保活（4.5分钟间隔）
- ✅ 并发请求支持
- ✅ 完整的 RobotService API

### OpenClaw 适配器特性

- ✅ 双向消息转发（野火IM ↔ OpenClaw）
- ✅ 消息格式自动转换
- ✅ 群聊防刷屏策略
- ✅ 会话上下文管理
- ✅ 自动重连
- ✅ 流式消息支持
- ✅ 白名单过滤

## API 列表

### 消息相关
- `SendMessage` - 发送消息
- `ReplyMessage` - 回复消息
- `RecallMessage` - 撤回消息
- `UpdateMessage` - 更新消息

### 用户相关
- `GetUserInfo` - 获取用户信息
- `GetUserInfoByMobile` - 通过手机号获取用户
- `GetUserInfoByName` - 通过用户名获取用户
- `ApplicationGetUserInfo` - 应用获取用户信息

### 群组相关
- `CreateGroup` - 创建群组
- `GetGroupInfo` - 获取群组信息
- `DismissGroup` - 解散群组
- `TransferGroup` - 转让群组
- `ModifyGroupInfo` - 修改群组信息
- `GetGroupMembers` - 获取群成员列表
- `AddGroupMembers` - 添加群成员
- `KickoffGroupMembers` - 踢出群成员
- `SetGroupManager` - 设置群管理员
- `MuteGroupMember` - 禁言群成员
- `QuitGroup` - 退出群组

### 机器人资料
- `GetProfile` - 获取机器人资料
- `UpdateProfile` - 更新机器人资料

## 协议说明

### 鉴权消息

```json
// 请求
{
  "type": "connect",
  "robotId": "FireRobot",
  "secret": "123456"
}

// 响应成功
{
  "type": "connect",
  "code": 0,
  "msg": "success"
}

// 响应失败
{
  "type": "connect",
  "code": 401,
  "msg": "Authentication failed"
}
```

### 请求消息

```json
{
  "requestId": "uuid-1234",
  "method": "sendMessage",
  "params": ["robotId", {"type": 0, "target": "userId"}, {"type": 1, "content": "Hello"}]
}
```

### 响应消息

```json
{
  "requestId": "uuid-1234",
  "code": 0,
  "msg": "success",
  "result": {"messageUid": 12345}
}
```

### 推送消息

```json
{
  "type": "message",
  "data": {
    "sender": "userId",
    "conv": {"type": 0, "target": "robotId", "line": 0},
    "payload": {"type": 1, "searchableContent": "Hello"},
    "timestamp": 1640000000000
  }
}
```

## 依赖

- Go 1.21+
- gorilla/websocket - WebSocket 客户端
- google/uuid - UUID 生成
- spf13/viper - 配置管理（适配器）
- uber/zap - 日志（适配器）

## 许可证

MIT
