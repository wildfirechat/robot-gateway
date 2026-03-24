# OpenClaw 野火IM 插件

OpenClaw 的野火IM 频道插件，支持收发消息、流式回复和文件传输。

> 本插件，依赖于[robot-gateway](https://github.com/wildfirechat/robot-gateway)，请先部署`robot-gateway`

## 安装
```
openclaw plugins install @wildfirechat/openclaw-plugin
```

## 升级
```
openclaw plugins update @wildfirechat/openclaw-plugin
```

## 开发
```bash
# 构建并打包
cd openclaw-plugin.js
npm install
npm run build
npm pack

# 安装到 OpenClaw
// 安装完之后，代码位于 ~/.openclaw/extensions/wildfire/，后续可以直接将 npm run build 后的 dist 目录里面的内容 覆盖到安装目录下的 dist 目录
openclaw plugins install ./openclaw-wildfire-1.0.0.tgz
openclaw restart
```

## 配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
      "wildfire": {
          "enabled": true,
          "accounts": {
              "default": {
                  "enabled": true,
                  "imUrl": "http://your_im_host",
                  "robotId": "your robot id",
                  "robotSecret": "your robot secret",
                  "requireMention": true,
                  "helpKeywords": "帮,请,分析,总结",
                  "whiteList": {
                      "enabled": false,
                      "allowedUsers": ["user001", "user002"],
                      "allowedGroups": ["group001"],
                      "deniedMessage": "未授权，不允许使用"
                  }
              }
          }
      },
  }
}
```

### 配置项说明

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `enabled` | 否 | 是否启用，默认 `true` |
| `imUrl` | 是 | Wildfire IM 服务地址（RobotService URL），端口默认是 80 |
| `robotId` | 是 | 机器人 ID |
| `robotSecret` | 是 | 机器人密钥 |
| `requireMention` | 否 | 群聊是否需要@机器人才回复，默认 `true` |
| `helpKeywords` | 否 | 触发回复的关键词，逗号分隔 |
| `whiteList.enabled` | 否 | 是否启用白名单，默认 `false` |
| `whiteList.allowedUsers` | 否 | 允许访问的用户 ID 列表 |
| `whiteList.allowedGroups` | 否 | 允许访问的群组 ID 列表 |
| `whiteList.deniedMessage` | 否 | 不在白名单时的回复文案，默认 `不允许使用` |

### 白名单说明

- `whiteList.enabled = false` 时，不做白名单校验，所有消息正常处理。
- `whiteList.enabled = true` 时，命中 `allowedUsers` 或 `allowedGroups` 任一条件即可继续处理。
- 未命中白名单时，插件会直接回复 `whiteList.deniedMessage`，然后结束本次处理。
- 私聊主要匹配 `allowedUsers`；群聊会额外匹配 `allowedGroups`。

## 特性

- **消息接收**: 支持私聊和群聊消息
- **流式回复**: AI 回复实时更新到同一条消息
- **文件传输**: 支持图片、视频、文件上传和发送
- **群聊过滤**: 支持@提及检测和关键词触发
- **白名单控制**: 支持用户和群组白名单，未授权时返回可配置提示语

## 目录结构

```
openclaw-plugin.js/
├── src/
│   ├── channel.ts      # 频道插件主实现
│   ├── clients.ts      # Wildfire 客户端管理
│   ├── config.ts       # 配置类型和验证
│   ├── inbound.ts      # 入站消息处理
│   ├── targets.ts      # 目标 ID 解析
│   └── utils.ts        # 工具函数
├── package.json
├── tsconfig.json
└── README.md
```

## 消息格式

### Target 格式

- 单聊: `user:用户ID` 或 `用户ID`
- 群聊: `group:群组ID`

### Mention 检测

- `mentionedType === 2`: @所有人，始终回复
- `mentionedType === 1`: @部分人，检查 `mentionedTarget`

## 调试


```bash
openclaw logs --follow
```

日志前缀 `[wildfire]` 即为插件输出。

## 依赖

- `@wildfirechat/robot-gateway-client-sdk`: 野火机器人网关客户端
- `@wildfirechat/server-sdk`: 消息内容模型

## License

MIT
