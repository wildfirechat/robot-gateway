# 野火IM机器人网关 SDK (Go)

Go 语言版本的野火IM机器人网关客户端SDK。

## 安装

```bash
go get github.com/wildfirechat/robot-gateway-sdk
```

## 快速开始

```go
package main

import (
    "log"
    "github.com/wildfirechat/robot-gateway-sdk/client"
    "github.com/wildfirechat/robot-gateway-sdk/protocol"
)

type MyHandler struct{}

func (h *MyHandler) OnMessage(msg *protocol.PushMessage) {
    log.Printf("Received: %s from %s", 
        msg.Data.Payload.SearchableContent, 
        msg.Data.Sender)
}

func (h *MyHandler) OnConnectionChanged(connected bool) {
    log.Printf("Connection changed: %v", connected)
}

func (h *MyHandler) OnError(err string) {
    log.Printf("Error: %s", err)
}

func main() {
    handler := &MyHandler{}
    robot := client.NewRobotServiceClient(
        "ws://localhost:8884/robot/gateway",
        handler,
    )

    if !robot.Connect("RobotID", "RobotSecret") {
        log.Fatal("Failed to connect")
    }

    // Send a message
    result, _ := robot.SendMessage(
        &protocol.Conversation{Type: 0, Target: "userId"},
        &protocol.MessagePayload{
            Type:              1,
            SearchableContent: "Hello!",
        },
    )

    if result.IsSuccess() {
        log.Printf("Sent! MessageUID: %d", result.Result.MessageUID)
    }

    select {} // Keep running
}
```

## API 文档

### 客户端创建

```go
// Default timeout (30 seconds)
client := client.NewRobotServiceClient(gatewayURL, handler)

// Custom timeout
client := client.NewRobotServiceClientWithTimeout(gatewayURL, handler, 60)
```

### 连接管理

```go
// Connect and authenticate
success := client.Connect(robotID, secret)

// Check status
client.IsConnected()
client.IsAuthenticated()
client.IsRunning()

// Close connection
client.Close()
```

### 消息处理

实现 `MessageHandler` 接口：

```go
type MessageHandler interface {
    OnMessage(message *protocol.PushMessage)
    OnConnectionChanged(connected bool)
    OnError(error string)
}
```

### 发送消息

```go
// Send text message
conv := &protocol.Conversation{
    Type:   0, // 0=单聊, 1=群聊
    Target: "userId",
    Line:   0,
}

payload := &protocol.MessagePayload{
    Type:              1, // 1=文本
    SearchableContent: "Hello!",
}

result, err := client.SendMessage(conv, payload)
```

### 用户相关

```go
// Get user info
result, err := client.GetUserInfo("userId")
if result.IsSuccess() {
    user := result.Result
    println(user.DisplayName)
}

// Get user by mobile
result, err := client.GetUserInfoByMobile("13800138000")

// Get user by name
result, err := client.GetUserInfoByName("username")
```

### 群组相关

```go
// Get group info
result, err := client.GetGroupInfo("groupId")

// Get group members
result, err := client.GetGroupMembers("groupId")

// Create group
groupInfo := &protocol.PojoGroupInfo{
    Name: "My Group",
}
members := []protocol.PojoGroupMember{
    {MemberID: "user1"},
}
result, err := client.CreateGroup(groupInfo, members, "", []int{0}, nil)
```

### 机器人资料

```go
// Get profile
result, err := client.GetProfile()
if result.IsSuccess() {
    println(result.Result.Name)
}

// Update profile
result, err := client.UpdateProfile(0, "New Name")
```

## 配置参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| reconnectInterval | 重连间隔 | 5秒 |
| heartbeatInterval | 心跳间隔 | 270秒 |
| requestTimeout | 请求超时 | 30秒 |

## 完整示例

查看 [example](example/main.go) 获取交互式命令行示例。

```bash
cd example
go run main.go ws://localhost:8884/robot/gateway RobotID RobotSecret
```
