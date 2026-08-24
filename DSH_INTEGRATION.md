# 野火IM 对接 DeepSeek Harness 集成设计文档

## 概述

本文档描述野火IM机器人网关（`robot-gateway`）与 DeepSeek Harness（以下简称 **DSH**）的集成方案。通过新增 `dsh-plugin.js` 插件模块，实现野火IM用户与 DSH Agent 之间的双向对话：用户在野火IM客户端与机器人私聊或群聊 @机器人，消息经机器人网关进入 DSH Agent 执行（可调用 DSH 的 bash/文件/网络/子代理等全部工具），Agent 的回复（含流式输出）实时回传到野火IM客户端。

> DSH 是 DeepSeek 的 agent harness（`dsh` CLI，profile 化 Cordis 插件栈，含 `web`/`tui`/`headless` 等 profile）。其插件模型与 OpenClaw 的 channel 插件模型类似，本设计完全复用本项目 `openclaw-plugin.js` 的既有模式与代码。

## 设计目标

| 目标 | 说明 |
|------|------|
| 双向桥接 | 野火IM 消息 ↔ DSH Agent 会话，双向实时 |
| 会话隔离 | 每个野火用户/群组对应独立 DSH 会话，多轮对话上下文不串扰 |
| 流式回复 | Agent 生成内容以野火流式消息（generating → completed）实时推送 |
| 群聊防打扰 | @提及 / 问号 / 关键词 / 白名单策略，复用 openclaw 插件的过滤逻辑 |
| 长任务支持 | 利用 DSH 的 goal 机制承载长时任务（代码开发、研究等），进度可查 |
| 零额外进程 | 方案 A 下插件运行在 DSH 进程内，无独立服务需要运维 |

## 方案对比与选型

### 方案 A：DSH 进程内插件（Channel Plugin）—— 推荐

插件本身是一个 **Cordis 插件**，安装进 `dsh web`（或其他 profile），作为 DSH 的"野火渠道"存在。插件内部使用 `@wildfirechat/robot-gateway-client-sdk` 以机器人身份连接 robot-gateway，收到野火消息后通过 `ctx.agents` 直接投递给 DSH Agent。

```
┌────────────────────────────────────────────────────────────────────────┐
│                           dsh 进程（--profile web）                       │
│  ┌──────────────┐   ┌──────────────────────────────────────────────┐  │
│  │  dsh web app │   │  @wildfirechat/dsh-wildfire（本插件）          │  │
│  │  (GUI/API)   │   │  ┌─────────────┐  ┌────────────────────────┐ │  │
│  └──────┬───────┘   │  │ Wildfire    │  │ Agent 会话管理器        │ │  │
│         │           │  │ 客户端       │  │ (ctx.agents + events)  │ │  │
│         │           │  │ (SDK)       │  │                        │ │  │
│         │           │  └──────┬──────┘  └───────────┬────────────┘ │  │
│         │           │         │ WebSocket(:8884)     │ 同进程调用    │  │
│         │           └─────────┼──────────────────────┼─────────────┘  │
│         │                     │                      │                │
└─────────┼─────────────────────┼──────────────────────┼────────────────┘
          │                     │                      │
┌─────────┴──────────────┐   ┌──┴──────────────────┐   │
│  野火机器人网关          │   │  野火IM 服务器       │   │
│  gateway(:8884/:8885)  │◀──│  (IM/RobotService)  │   │
└────────────────────────┘   └─────────────────────┘   │
          ▲ 用户野火客户端                                  │
          └──────────────────────────────────────────────┘ 浏览器 GUI 同进程并存
```

**优点**：
- 原生使用 DSH 全部能力：模型选择、工具链、会话持久化、goal、子代理、HMR 热更新
- 流式事件（`assistant/chunk`）与 GUI 同源，实现简单可靠
- 不引入独立进程，无额外部署与端口
- 会话持久化由 DSH 负责（session 落盘），DSH 重启后可 `resume`

**缺点**：依赖 DSH 进程运行；插件与 DSH 版本有耦合（通过 peerDependencies 约束）。

### 方案 B：独立桥接服务（Adapter Service）

参照 `openclaw-adapter.js` / `openclaw-adapter`（Java）模式，实现独立 Node 服务，双向维护：一端连野火网关，一端连 DSH。

| 子方案 | DSH 侧对接方式 | 优缺点 |
|--------|---------------|--------|
| B1 | 每条消息 `dsh --profile headless "task"` | 实现最简单；但每次冷启动（数秒）、无会话连续性（headless 每次新建 agent），仅适合一次性问答 |
| B2 | 连接 `dsh web` 的 `/api` Typert RPC（浏览器同款协议，WebSocket 上行） | 有会话连续性、流式；但需实现 Typert RPC 客户端（descriptor 校验、连接协议、trust），协议内部且无公开文档，维护成本高 |

**结论**：独立桥接仅作为无法把插件装进 DSH 进程时的兜底（如 DSH 由他人托管）。本项目默认采用 **方案 A**；B1 在文末作为应急方案说明。

## DSH 插件机制（前置知识）

DSH 的 profile 是一个目录（如 `~/.dsh/profiles/web`）：

```
~/.dsh/profiles/web/
├── package.json            # dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
├── cordis.patch.yml        # 用户层 patch（[] 默认空）
└── node_modules/           # pnpm 安装的插件依赖
```

- **Bundle**：`@deepseek-ai/dsh-base`（核心：llm/session/agent/tools/持久化等）+ `@deepseek-ai/dsh-web-app`（Web 界面）
- **Patch 层**：每个 bundle 自带 `cordis.patch.yml`，用 `insert` 列表声明插件行 `{id, name, config}`；后写覆盖前写
- **安装插件**：`dsh plugin --profile web add <pkg>`（等价于在 profile 目录执行 pnpm add）
- **激活插件**：在用户层 `~/.dsh/profiles/web/cordis.patch.yml` 中 `insert` 插件行并配置
- **插件格式**：Cordis 插件，导出 `{ name, inject, Config, apply(ctx, config) }`（或默认导出函数）

本插件的目标形态：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: wildfire
      name: '@wildfirechat/dsh-wildfire'
      config:
        gatewayUrl: ws://your_gateway_host:8884/robot/gateway
        robotId: your_robot_id
        robotSecret: your_robot_secret
        # ... 见「配置参考」
```

## 插件模块设计

### 目录结构

```
dsh-plugin.js/
├── package.json          # 包定义（DSH 插件元数据 + peerDependencies）
├── tsconfig.json
├── README.md             # 安装/配置/使用说明
└── src/
    ├── index.ts          # 插件入口：register service，start/stop 生命周期
    ├── config.ts         # 配置类型、读取与校验
    ├── clients.ts        # Wildfire RobotServiceClient 生命周期管理
    ├── agent.ts          # DSH Agent 会话管理器（IM 会话 ↔ DSH session 映射）
    ├── inbound.ts        # 入站消息处理：过滤 → 投递 → 流式回复
    ├── whitelist.ts      # 白名单过滤（复用 openclaw 逻辑）
    └── utils.ts          # 群聊过滤、mention 检测、payload 解析等
```

### 各模块职责

| 模块 | 职责 | 对标 openclaw 插件 |
|------|------|-------------------|
| `index.ts` | 注册插件 service，启动/停止 Wildfire 客户端 | `index.ts` |
| `config.ts` | 读取 `ctx` 中插件 config，校验必填项 | `config.ts` |
| `clients.ts` | 创建/连接/关闭 `RobotServiceClient`，暴露 onMessage 回调 | `clients.ts` |
| `agent.ts` | **新增**：`ctx.agents` 封装 —— 按 IM 会话键创建/复用/销毁 DSH Agent，订阅 `session/event`，聚合流式文本 | — |
| `inbound.ts` | 消息解析、群聊过滤、白名单、会话串行队列、流式消息收发 | `inbound.ts` |
| `whitelist.ts` | 用户/群组白名单 | `whitelist.ts` |
| `utils.ts` | 群聊触发策略、mention 检测、payload 提取 | `utils.ts` |

## 核心数据流

### 入站消息流（野火 IM → DSH Agent）

```
1. 用户发消息给机器人（私聊/群聊@）
2. 野火IM → robot-gateway(:8885 webhook) → WebSocket PushMessage
3. 插件 clients.ts 收到 PushMessage (type="message", data={sender, conv, payload})
4. inbound.ts:
   a. 忽略非内容消息（系统消息、通知等）
   b. 群聊触发策略过滤（@提及/问号/关键词/白名单）
   c. 白名单校验
   d. 计算 IM 会话键 → 查/建 DSH Agent 会话（agent.ts）
   e. 发送"…" generating 占位消息（客户端立即出现等待态）
   f. agent.followup(createUserMessage({text: 消息文本}))
   g. 订阅该 session 的 session/event：
      - assistant/chunk  → 累积文本，节流推送 generating 更新
      - assistant/message → 更新最终文本
      - turn/end          → 推送 completed 最终消息，清理订阅
5. Agent 执行（模型推理 + 工具调用），期间可继续回传 chunk
```

### 出站回复流（DSH Agent → 野火 IM）

```
session/event(assistant/chunk) ──► 聚合文本
        │
        ▼
sendStreamingReply(streamId, text, state="generating")
   StreamingTextGeneratingMessageContent{ text, streamId }   // 同一条消息持续更新
        │
        ▼ (turn/end)
sendStreamingReply(streamId, finalText, state="completed")
   StreamingTextGeneratedMessageContent{ text, streamId }    // 定型
```

### 会话映射

| 野火会话 | IM 会话键（小写） | DSH SessionId（SHA-256 前缀） |
|---------|------------------|------------------------------|
| 私聊（conv.type=0） | `wildfire:user:{sender}` | `wildfire-{sha256(userId)[:20]}` |
| 群聊（conv.type=1/2） | `wildfire:group:{conv.target}` | `wildfire-{sha256(groupId)[:20]}` |

- 同一 IM 会话内多轮对话复用同一 DSH Agent（上下文连续）
- **会话重建**（如 `/reset` 显式重置）后该目录的 epoch 递增，session id 变化，旧上下文不再恢复；**`/cwd` 切换目录 = 切换会话**（session id 由 群+目录 派生 `wildfire-{hash[:20]}-{dirHash[:16]}`，各目录会话独立持久化，切回已访问目录 `resume` 恢复其上下文）
- DSH 会话持久化：DSH 重启后可通过 `ctx.agents.resume({sessionId})` 恢复
- 会话空闲超时（默认 24h）后 `handle.dispose()` 释放，防内存泄漏
- 每会话串行队列：同一会话同时只允许一个 Agent 任务在途（复用 openclaw 的 `sessionQueues` 模式）

### 流式节流

`assistant/chunk` 是 token 级增量，若每 chunk 都调 `sendMessage` 会打爆野火网关。采用：
- 时间节流：≥ 300ms 才推送一次 generating 更新
- 文本去重：仅当聚合文本有变化才推送
- 首帧立即推送（让客户端尽快出现流式态）

## 消息格式映射

### 野火 PushMessage → DSH 用户消息

```typescript
// 野火 PushMessage.data
{ sender, conv: {type, target, line}, payload: {type, content, searchableContent, ...} }

// DSH 用户消息
createUserMessage({
  content: [{ type: "text", text: bodyText }],
  source:  { kind: "user" },
})
```

| 野火字段 | DSH 侧 | 说明 |
|---------|--------|------|
| `sender` | 会话键 `wildfire:user:{sender}` | 私聊会话归属 |
| `conv.target` | 会话键 `wildfire:group:{conv.target}` | 群聊会话归属 |
| `payload.searchableContent/content` | `content[0].text` | 文本正文；语音消息经 ASR 后写入（可选） |
| `payload.type` | 类型判断 | 1 文本 / 2 语音 / 3 图片 / 4 视频 / 5 文件 |
| 消息ID | （可写入消息正文前缀，可选） | 便于 Agent 上下文理解 |
| `payload.mentionedTarget` | （不映射） | 仅用于触发策略判断 |

### DSH session/event → 野火消息

| DSH 事件 | 野火消息 | 说明 |
|---------|---------|------|
| `assistant/chunk` | `StreamingTextGeneratingMessageContent` | 流式增量，`streamId` 唯一 |
| `assistant/message`（text block） | 聚合文本源 | 作为 completed 的内容 |
| `turn/end` | `StreamingTextGeneratedMessageContent` | 最终定型消息 |
| `turn/end` reason=`error` | 文本错误提示 | 如 `Processing failed: ...` |

### 会话运行状态与 Token 计量（scope=31 会话级用户设置）

Agent 运行状态（state/phase/toolName/model/reasoningEffort）、交互/结果态（interaction/reason/error/cwd/sessionId/goal/**lastChange**）走 **scope=31 type=1 状态**（键 `..._1`）；Token 计量（usage/turn/context/cacheHitRatePct/speed/metricsAt）走 **scope=31 type=2 统计**（键 `..._2`）；AI 面板数据（组合查询结果：model 目录/effort/沙箱/计划/cwd/目录列表）走 **scope=31 type=3 面板数据**（键 `..._3`）——三通道分离：状态是高频瞬态、统计是低频累积（回合结束必推）、面板数据由 207 组合查询/更新刷新。面板交互经 **DSH_Command(207)** 透明消息完成（不落消息流），更新后写 type=1 `lastChange`（变更可见）。客户端分别订阅。完整字段字典见 `INTERACTION_DESIGN.md` §2.2。

## 工作目录（Workspace）选定

Agent 的工作目录在 **DSH 会话创建时写入会话头（`meta.cwd`）**，之后不可变。headless 模式的默认值是 `process.cwd()`（DSH 进程启动目录）；web profile 通过 `ctx.workspaceRegistry` 按会话 cwd 归类工作区（GUI 工作区视图可见）。因此 IM 插件的目录选定必须在**创建会话时解析**，切换目录 = 销毁旧会话、用新 cwd 重建。

### 三级配置模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `global`（默认） | 所有会话运行在 `workspace.path`（默认 `process.cwd()`） | 单机单项目、自用机器人 |
| `per-session` | 每个会话独立目录 `workspace.sessionDir/<sessionId>` | 多用户共用一台机器，互相隔离 |
| `mapped` | `workspace.map` 按会话键（`wildfire:user:x` / `wildfire:group:x`，也支持裸 ID）映射目录，未命中回退 `path` | 每个用户/群组对接不同代码仓库 |

### 解析优先级

```
/cwd 命令设置的运行时覆盖（已持久化）  >  mapped 映射  >  per-session 目录  >  global path  >  process.cwd()
```

### `/cwd` 命令

`workspace.allowCwdCommand: true` 时，**私聊和群聊**均可使用：

| 命令 | 权限 | 行为 |
|------|------|------|
| `/cwd` | 任一准入成员 | 查询当前会话的工作目录 + 项目根目录 |
| `/cwd <path>` | 管理员 / 群主（群聊）/ 管理员（私聊） | 绑定工作目录到该会话（**持久化**），会话重置 |
| `/cwd clear` | 同上 | 清除绑定，恢复默认配置 |
| `/ls [子目录]` | 任一准入成员 | 列出项目根目录（或子目录）内容（目录/文件，文件带大小） |

- 私聊：管理员（`access.adminUsers`；未配置管理员时任一准入用户）
- 群聊：管理员群组（`access.adminGroups` 成员）或**群主**（`access.groupOwnerCanManage`，默认开启；通过 `getGroupInfo` 校验群主，**机器人须为群成员**）
- **路径解析**：绝对路径按原样；`~`/`~/x` 为家目录；**相对路径一律按项目根目录 `workspace.root` 解析**（`/cwd docs` → `<root>/docs`）
- **项目根目录** `workspace.root`：所有项目都在此目录下。未配置时回退链 `autoRoot` → 第一个 `allowedRoot` → `path`。`/create-group auto` 的自动目录与 `/ls` 默认列表也基于它
- **目录不存在**：发 **DSH_Question 确认卡片**——`✅ 创建`（`mkdir -p` 后绑定）/ `❌ 取消`；卡片自定义回答可直接输入**新路径**重新选择（深度保护最多 3 轮）；60s 未应答自动取消
- 路径须位于 `allowedRoots` 内（已存在目录 realpath 比较；不存在目录词法比较）
- 切换/绑定后 dispose 当前活跃 Agent；下一次消息按**新目录**派生 session id（`resume` 恢复该目录已有上下文，或新建）——**各目录会话独立持久化，切回旧目录可恢复其上下文**（见 INTERACTION_DESIGN.md §7 决策 17；`/reset` 仍是显式清空）
- **群聊绑定成功后自动改群名**：机器人调用 `modifyGroupInfo(type=0)` 把群名改为目录**最后一段**（`/a/b/c` → 群名 `c`），私聊不生效；改名为尽力而为，失败不影响 `/cwd` 流程
- 绑定持久化到 `workspace.persistFile`（默认 `~/.dsh/wildfire-workspaces.json`，`workspace.persist=false` 关闭），**重启不丢失**

### 多群多工作区（推荐用法）

每个群 = 一个独立会话 + 一个独立工作目录，**无需预先在配置里罗列**，全部动态绑定：

```
1. 野火IM 客户端建群（如"项目A群"），把机器人拉进群
2. 群主在群里发:  /cwd /data/projects/project-a   （绑定群→目录，持久化）
3. 群成员 @机器人 提问                                （会话在 project-a 开启）
4. 另一个群同样操作:  /cwd /data/projects/project-b  （互不干扰）
5. 机器人重启后绑定仍在，无需重新配置
```

- 每群独立会话键 `wildfire:group:{groupId}` → 独立 DSH Agent（上下文隔离）✓
- 每群独立工作目录（动态 `/cwd` 绑定 + 持久化）✓ 本设计
- 每群独立串行队列，消息不串扰 ✓
- 群内查询 `/cwd` 对成员开放；修改仅群主/管理员

### 安全约束

- `workspace.allowedRoots: ["/data/projects"]`：所有解析出的目录（含 `/cwd` 命令路径）必须位于这些根目录内（realpath 比较），防止 IM 用户把 Agent 指向任意路径
- `per-session` 目录自动 `mkdir -p`
- 群聊 `/cwd` 修改仅限群主/管理员群组

## 访问权限控制

权限分为两层：

| 层级 | 机制 | 说明 |
|------|------|------|
| **准入**（谁能触发机器人） | `whiteList` | 白名单启用时按以下来源任一命中即放行：**机器人 owner**（`includeOwner`，经 `getProfile()` 获取）、静态 `allowedUsers` / `allowedGroups`、动态 `/allow` 名单；未命中回 `deniedMessage`；`enabled=false` 时全员可用 |
| **管理**（谁能执行命令） | `access.adminUsers` / `adminGroups` | 门控管理命令；未配置管理员时，任一准入用户可执行（配合功能开关） |

### 白名单

```yaml
whiteList:
  enabled: true
  allowedUsers: ["user001", "user002"]   # 静态指定用户
  allowedGroups: ["grp001"]              # 静态指定群组
  deniedMessage: "未授权，不允许使用"
  includeOwner: true                     # 机器人 owner 自动放行（默认 true）
  persistFile: ~/.dsh/wildfire-allowlist.json  # 动态名单持久化文件
```

**动态白名单命令**（私聊=管理员；群聊=群主/管理员）：

| 命令 | 行为 |
|------|------|
| `/allow <userId>` | 把用户加入白名单（持久化，重启不丢） |
| `/disallow <userId>` | 把用户移出白名单 |
| `/allowlist` | 查看当前白名单（启用状态、owner、静态/动态用户、群组） |

owner 说明：插件连接野火网关后调用 `getProfile()` 获取 `OutputRobot.owner`（野火 `t_robot._owner`，BotFather 创建机器人时记录），白名单启用时 owner 永远放行；若 owner 获取失败（`includeOwner=true` 时）仅静态/动态名单生效。

命令执行条件：`权限校验` +（`/cwd`、`/model` 等）`对应功能开关开启`。群聊中 `/model` 等仍仅私聊。

```yaml
access:
  adminUsers: ["user001", "user002"]   # 管理员用户 ID
  adminGroups: ["grp-admin"]           # 管理员群组 ID（群聊命令用）
```

> DSH 侧的工具审批（approval policy）、沙箱权限等仍由 DSH 自身策略控制，IM 用户只能通过消息与 Agent 交互，无法绕过。

## 大模型与推理等级

### 机制说明（DSH 侧事实）

- DSH 的模型选择是 `ModelSelection = { provider, model, reasoningEffort? }`
- 创建 Agent 时经 `agentOptions: {provider, model}` + `setup: installModelSelection(agentCtx, selectionRef)` 写入
- **会话级"活"切换**：`selectionRef.current = 新选择` 后，Agent 的**下一条请求**即生效（`agent/request` 钩子读取），**无需重建会话**——这与工作目录（cwd 固化）不同，模型切换不丢上下文
- 推理等级（reasoningEffort）由各适配器定义（如 deepseek 的 `low/medium/high`），经 `ReasoningEffortId` 传递；DSH 默认选择可用 `ctx.agentDefaultModel.currentSelection()` 读取

### 插件设计

**模型目录来源**：可选模型来自 **DSH 运行时目录**——`ctx.llm.listProviders()` + `ctx.llm.listModels(provider)`（适配器 interrogating provider 端点的结果），与 web UI 模型选择器同源。`model.allowed` 预设保留为**可选快捷方式**，不再是主路径。

**配置**（`model`）：

```yaml
model:
  default: fast                    # 默认预设 ID；省略则用 DSH 当前选择
  allowed:                         # 可选：预设快捷方式（主路径为运行时目录）
    fast:  { provider: "deepseek", model: "deepseek-chat",        reasoningEffort: "low" }
    deep:  { provider: "deepseek", model: "deepseek-reasoner" }
    fastx: { provider: "deepseek", model: "deepseek-chat",        reasoningEffort: "high" }
  map:                             # 按会话键固定模型
    "wildfire:user:user001": deep
  allowModelCommand: true          # 开启 /model /effort 命令（管理员门控）
```

**解析优先级**：`/model`、`/effort` 运行时覆盖 > `model.map` > `model.default` 预设 > DSH `agentDefaultModel.currentSelection()`

**命令**（私聊 + 管理员）——模型与推理等级**分开设置**：

| 命令 | 行为 |
|------|------|
| `/model` | 查看当前模型 + 运行时模型目录（按 provider 分组），附预设快捷列表 |
| `/model <provider/model>` | 切换到目录中的模型（**只改模型，保留当前推理等级**；裸模型 id 在多 provider 重名时提示消歧） |
| `/model <预设ID>` | 目录匹配不到时按预设切换（向后兼容，含预设的 effort） |
| `/effort` | 查看当前推理等级 |
| `/effort <等级>` | 在当前模型上设置推理等级（等级 ID 由适配器定义） |
| `/reset` | 清空会话上下文（恢复为默认模型/目录时用） |

切换模型后插件调用 `agents.applyModelLive(key, selection)` 立即应用到在途会话（**下一条消息生效，上下文保留**）；若会话尚未创建，覆盖值在下一次创建时经 `modelProvider` 生效。

## 群聊过滤策略（复用 openclaw）

> **斜杠命令优先级最高**：任何以 `/` 开头的消息一律视为命令，**跳过以下全部触发策略**（`/cwd /path` 这类无@/问号/关键词的命令不会被丢弃），也**不会**被消费为 pending 卡片的文本应答；`/stop` 甚至先于会话串行队列处理（运行中的 turn 可被立即中断）。

`utils.ts::shouldRespondToGroupMessage(text, messageData, config)`：

1. **@提及**：`mentionedType===2`（@所有人）→ 回复；`mentionedType===1` 且 `mentionedTarget` 含机器人ID → 回复
2. **问号结尾**：`/.*[？?]$/` → 回复
3. **关键词**：`config.helpKeywords`（默认 `帮,请,分析,总结`）命中 → 回复
4. **默认（`requireMention` 未配置/false）**：群内所有消息触发，无需@；配置 `requireMention: true` 后仅 @提及/问号/关键词触发
5. **白名单**：owner / `whiteList.allowedUsers/allowedGroups` / 动态 `/allow` 名单任一命中 → 处理；未命中回 `deniedMessage` 后结束

> **功能开关被关闭的命令不再静默丢弃**：`/cwd`（`workspace.allowCwdCommand`）、`/model`/`/effort`（`model.allowModelCommand`）未启用时，回复明确提示"命令未启用（需配置对应开关）"；未知 `/xxx` 命令提示 `/help`。

## 会话沙箱模式（/sandbox）

DSH 的沙箱策略（`dsh-sandbox-policy`）是文件安全的唯一硬围栏；部署默认由 profile 配置（`sandbox-policy.mode`，fail-safe `read-only`）。插件提供**按会话运行时切换**：

| 命令 | 权限 | 行为 |
|------|------|------|
| `/sandbox` | 私聊=管理员；群=创建者/管理员 | 查看当前模式（区分"会话覆盖/部署默认"）+ 可选模式列表 |
| `/sandbox <mode>` | 同上 | 切换模式：`read-only` 只读 / `workspace-write` 仅写工作区 / `danger-full-access` 完全放开 |

- 实现：`setSandboxMode(session, mode)` 写入**会话日志的 `sandbox/mode` 事件**——重放即状态，随会话 resume 持久化，**下一次工具调用生效**；无需 profile 重启
- 群内为**共享会话**，创建者/管理员切换对全群生效；升级到 `danger-full-access` 属危险操作，仅创建者/管理员可执行
- 会话未激活（尚未发过消息）时提示先激活；`ctx.sandboxPolicy` 服务未加载时回复"服务不可用"（不会崩溃）
- 依赖 `@deepseek-ai/dsh-sandbox-policy`（含于 `dsh-base` bundle，通常无需额外配置）

## 配置参考

插件 config（`cordis.patch.yml` 中 `config` 字段）：

```yaml
config:
  gatewayUrl: ws://your_gateway_host:8884/robot/gateway   # 必填
  robotId: your_robot_id                                  # 必填
  robotSecret: your_robot_secret                          # 必填
  asrServer: http://your_asr_host:port/asr                # 可选，语音转文字
  requireMention: true                                    # 群聊需@才回复
  helpKeywords: "帮,请,分析,总结,怎么,如何"                 # 触发关键词
  whiteList:
    enabled: true
    allowedUsers: ["user001"]        # 静态允许用户
    allowedGroups: ["grp001"]        # 静态允许群组
    deniedMessage: "未授权，不允许使用"
    includeOwner: true               # 机器人 owner 自动放行
  session:
    idleTimeoutMs: 86400000        # 会话空闲回收（默认24h）
    maxSessions: 200               # 最大并发 Agent 会话
  streaming:
    throttleMs: 300                # 流式推送节流
    initialPlaceholder: "…"        # 占位消息文本
  workspace:
    mode: global                   # global | per-session | mapped
    path: /data/projects/default   # 全局目录（默认 process.cwd()）
    sessionDir: /data/wildfire-workspaces  # per-session 模式的父目录
    map:                           # mapped 模式：会话键 → 目录
      "wildfire:user:user001": /data/projects/repo-a
      "grp001": /data/projects/repo-b
    allowedRoots: ["/data/projects"]  # 可选安全围栏（realpath 比较）
    root: /data/projects          # 项目根目录：相对 /cwd、/create-group auto、/ls 都基于它（缺省回退 autoRoot → 第一个 allowedRoot → path）
    allowCwdCommand: false         # 是否允许 /cwd /ls 命令（私聊+群聊，按权限）
    persist: true                  # 持久化 /cwd 绑定（重启不丢）
    persistFile: ~/.dsh/wildfire-workspaces.json
  access:
    adminUsers: ["user001"]        # 管理员用户（门控管理命令）
    adminGroups: []                # 管理员群组
    groupOwnerCanManage: true      # 群主可在本群执行 /cwd（默认开启）
  model:
    default: fast                  # 默认预设 ID（省略用 DSH 当前选择）
    allowed:                       # 可选模型预设
      fast: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" }
      deep: { provider: "deepseek", model: "deepseek-reasoner" }
    map:                           # 会话键 → 预设 ID
      "wildfire:user:user001": deep
    allowModelCommand: false       # 是否允许私聊 /model /effort 命令
  media:
    downloadDir: /tmp/wildfire-media  # 入站媒体临时目录
    outboundEnabled: true          # 解析回复中的 [image:path]/[media:path] 标记并发送
  interaction:
    askUserEnabled: true           # 注册 userQuestions provider（IM 回答提问）
    approvalEnabled: true          # 注册审批 answerer（IM 同意/拒绝）
    askUserTimeoutMs: 300000       # 提问等待超时
    approvalTimeoutMs: 120000      # 审批等待超时
    approvedLabel: 同意
    deniedLabel: 拒绝
```

## 部署

### 0. 机器人平台号（自动探测，无需配置）

机器人 SDK 连接网关（`/robot/gateway` WebSocket）时，鉴权消息（connect）携带 `platform` 字段（野火 Platform 号）。SDK **按运行环境自动探测**：Linux=`7`、macOS=`4`（OSX）、Windows=`3`，无法识别时兜底 `7`（Linux）。网关把该平台存入会话，并在调用 im-server `/robot/set_online` 设置机器人上下线时使用它——保证客户端看到机器人在**正确平台**在线。插件无需任何配置；仅特殊场景（如模拟 WEB 在线）可用配置项 `gatewayPlatform` 覆盖。SDK 未上报时（旧版 SDK），网关按默认平台（Linux=7）处理。

### 1. 打包并安装插件

```bash
cd dsh-plugin.js
npm install
npm run build
npm pack                                  # 生成 @wildfirechat-dsh-wildfire-x.y.z.tgz
dsh plugin --profile web add ./wildfire-dsh-1.0.0.tgz
```

### 2. 激活并配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，按上文「DSH 插件机制」示例 insert 插件行并填写 config。

### 3. 启动与验证

```bash
dsh web                                 # 启动（浏览器 GUI + 插件同时运行）
# 日志中出现 [wildfire] connected as <robotId> 即连接成功
```

> **`dsh` 命令找不到？** `npx @deepseek-ai/dsh web` 只是临时执行，不会安装命令。先 `npm install -g @deepseek-ai/dsh`，再运行 `dsh --version` 确认。

野火客户端搜索机器人ID，私聊发送消息，应看到占位 → 流式 → 完成。

### 4. 后台运行与开机自启（机器人需 7×24 在线）

**简单后台（nohup）**：

```bash
nohup dsh web > ~/.dsh/dsh-web.log 2>&1 &
tail -f ~/.dsh/dsh-web.log      # 查看日志
pkill -f "dsh web"              # 停止
# 未全局安装时：nohup npx --yes @deepseek-ai/dsh web > ~/.dsh/dsh-web.log 2>&1 &
```

**macOS launchd（开机自启 + 崩溃自动重启）**：`~/Library/LaunchAgents/com.dsh.web.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/dsh</string>   <!-- which dsh 查实际路径 -->
    <string>web</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/rain/Workspace/robot-gateway</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/rain/.dsh/dsh-web.log</string>
  <key>StandardErrorPath</key><string>/Users/rain/.dsh/dsh-web.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.dsh.web.plist    # 启动
launchctl unload ~/Library/LaunchAgents/com.dsh.web.plist  # 停止
```

**Linux systemd**：`/etc/systemd/system/dsh-web.service`，`ExecStart=/usr/local/bin/dsh web`（`which dsh` 查路径）+ `Restart=on-failure`。

## 错误处理与容错

| 故障 | 处理 |
|------|------|
| 野火网关断连 | SDK 自动重连+重鉴权（openclaw 已验证的机制） |
| DSH Agent 创建失败 | 记录错误，回退文本提示，不崩溃 |
| 模型请求失败（`turn/end` reason=error） | 发送错误文案消息 |
| 流式发送失败 | 仅记录日志，最终 completed 兜底发送 |
| 会话超上限 | 按 LRU 回收最久未活动会话 |
| 消息格式异常 | 记录原始 payload 并跳过，不影响后续消息 |

## 监控与日志

- 日志前缀 `[wildfire]`，分级：DEBUG（chunk 细节）、INFO（连接/会话事件）、WARN（重连/过滤）、ERROR（失败）
- 连接状态：`[wildfire] connection changed: true/false`
- 会话指标：活跃会话数、流式消息数、错误率（可扩展 DSH 侧 telemetry 上报）
- DSH GUI 会话列表天然可见每个野火会话的 Agent 轨迹

## 实施路线图

| 里程碑 | 内容 | 验收 |
|--------|------|------|
| M1 骨架 | `dsh-plugin.js` 目录、配置、生命周期、连接野火网关 | 日志显示连接成功 |
| M2 私聊 | 私聊消息 → Agent → 完整回复（非流式） | 私聊可对话 |
| M3 流式 | `assistant/chunk` → generating/completed 流式消息 | 客户端看到流式打字效果 |
| M4 群聊 | 群聊过滤 + 白名单 | 群聊@机器人正常、不打扰 |
| M5 会话 | 多轮上下文、会话回收、重启 resume | 多轮对话上下文连续 |
| M6 增强 | 语音 ASR、文件/图片收发、goal 长任务 | 文件消息可达 Agent，长任务进度可见 |

## 备选方案 B1：headless 一次性问答（应急）

若无法在 DSH 进程内安装插件，可用独立服务每次调用：

```bash
dsh --profile headless "用户消息"        # 输出最后一条 assistant 文本
```

- 每次冷启动 3~10s，仅适合低频、无上下文场景
- 可配合 `--patch` 注入系统提示词约束输出
- 完整桥接服务代码结构复用 `openclaw-adapter.js`（把 OpenClaw WebSocket 段替换为 child_process 调用 headless）

## 功能差距分析（DSH web UI vs 野火 IM 插件）

本节逐项对比 `dsh web` GUI 已实现的功能与本插件现状，标注差距与 IM 侧的落地方式。

### 1. 插件已实现 ✅

| 功能 | 说明 |
|------|------|
| 会话隔离 | 每用户/每群独立 DSH Agent 会话，上下文互不串扰 |
| 流式回复 | `assistant/chunk` → generating/completed 流式消息 |
| 群聊过滤 | @提及/问号/关键词触发 |
| 白名单 | 用户/群组准入 + deniedMessage |
| 工作目录 | global/per-session/mapped + `/cwd` 动态绑定（持久化） |
| 模型/推理等级 | `/model`、`/effort` 会话级切换（活生效） |
| 管理权限 | admin 用户/群组 + 群主门控 |

### 2. 自动获得（Agent 工具，无需插件实现）🎁

插件与 GUI 跑在**同一个 Agent 运行时**，以下 web UI 展示/触发的 Agent 能力，IM 渠道**自动继承**，无需任何代码：

| 能力 | 对应包 |
|------|--------|
| bash/pwsh 终端执行 | `dsh-tool-bash` / `dsh-tool-pwsh` |
| 文件读写/搜索 | `dsh-tool-fs` / `dsh-tool-fs-search` |
| 网络搜索 | `dsh-tool-web` / `dsh-web-search-deepseek` |
| 任务清单 | `dsh-tool-todo` |
| goal 工具 | `dsh-tool-goal`（Agent 自建目标） |
| 后台任务 | `dsh-tool-jobs` / `dsh-jobs-local` |
| 子代理 | `dsh-tool-subagent`（spawn/fork） |
| 工作流 | `dsh-tool-workflow` |
| Ralph 循环 | `dsh-tool-ralph` |
| 技能 | `dsh-tool-skill` |
| 定时任务 | `dsh-schedule` |
| 上下文自动压缩 | `dsh-compaction-basic` |
| 会话持久化/日志 | `dsh-session-persistence-jsonl` |
| 沙箱/审批策略 | `dsh-sandbox-local` / `dsh-user-approval` |

### 3. 未实现但可补（IM 可交互）⚠️ —— 按优先级

| 功能 | web UI | 插件现状 | IM 落地方式 | 优先级 |
|------|--------|---------|------------|--------|
| **媒体收发** | 附件上传、图片/文件 | ✅ 已实现 | 入站：下载 `mediaUrl`→图片经 `ctx.attachments.saveImages` 转 image block（模型可看图）、其他文件转本地路径文本；语音走 ASR；出站：回复中 `[image:path]`/`[media:path]` 标记→上传野火发图片/文件消息 | P0 ✅ |
| **ask_user 提问** | `ui-user-questions` 输入框 | ✅ 已实现 | `ctx.userQuestions.registerProvider({ask})` → 发 IM 消息等用户回复（选项匹配/自定义文本） | P0 ✅ |
| **工具审批** | `ui-permission` 审批弹窗 | ✅ 已实现 | 注册 `approval/request` 瀑布监听 → IM 转发工具名+原因 → 用户回复同意/拒绝 → `allowed-once`/`rejected`（超时→`cancelled`） | P0 ✅ |
| **plan 模式审阅** | `ui-plan` | ✅ 随 userQuestions 自动获得 | `plan-review` intent 走同一 provider seam | P1 ✅ |
| `/goal` 命令 | `ui-goal` | ✅ 已实现 | `/goal <groupId> [目标]` 查看/创建；`/goal <groupId> pause\|resume` 暂停/恢复（`ctx.goals.pause/resume`），结果发 DSH_Goal 卡片 | P1 ✅ |
| `/plan` 命令 | `ui-commands` | ✅ 已实现 | `/plan` 查询 / `/plan on\|off` 切换（`ctx.planMode.get/set`）；计划审阅经 userQuestions → DSH_Question 卡片 | P1 ✅ |
| `/compact` | 命令面板 | ✅ 已实现 | `/compact` 手动压缩（`ctx.compaction.compactNow`），回复压缩规模；运行中提示 busy | P1 ✅ |
| `/jobs` | `ui-jobs` | ✅ 已实现 | `/jobs` 汇总所有存活会话 agent 的 `ctx.jobs.list()`，标注所属群/私聊 | P1 ✅ |
| 语音 ASR | — | ✅ 已实现（复用 openclaw 的 SSE 解析） | `asrServer` 配置后语音先转文字再进 Agent | P1 ✅ |
| `/stop` | — | ✅ 已实现 | `agent.cancel({kind:'user'})` 中断当前 turn，pending 卡片过期，状态回 idle；私聊+群聊可用 | P1 ✅ |
| `/new` | — | ✅ 已实现 | `/new <groupId>` 重置指定群会话（epoch++ 重建，工作区保留） | P1 ✅ |
| 消息反馈 | `ui-message-feedback` 👍/👎 | ❌ 无 | `/feedback <text>`（`recordFeedback(session, text)`）或 👍/👎 表情消息 | P2 |
| `/skills` | `ui-skill` | ❌ 无 | `ctx.skills` 列技能 | P2 |
| `/help` | — | ✅ 已实现 | 命令帮助列表（按权限过滤）；未识别 `/xxx` 命令兜底提示 | P2 ✅ |
| 会话标题 | `session-title` 自动标题 | ❌ 无 | `/title` 查询（可选） | P3 |

### 4. 不适合 IM（纯 GUI/浏览器）✖️

- 界面框架：主题、布局、侧边栏、设置面板、目录选择器、多语言、插槽/基础组件
- 会话历史浏览、`ui-trajectory` 轨迹可视化、`ui-tool` 工具调用可视化、`ui-workflow-run` 运行界面、`ui-cordis` 控制台
- 浏览器信任/认证（trusted host）、客户端 HMR 热更新

### 5. 部署模式：web GUI 与 IM 可以并存（不是二选一）

插件与 web GUI 挂在**同一个 Agent 运行时**上，两种部署形态：

#### 形态 A：并存模式（`dsh web` profile + 本插件）—— GUI 监督 + IM 对话

同一进程内浏览器 GUI 与 IM 同时可用，**会话完全互通**：IM 会话在 GUI 会话列表中可见（同一批持久化会话），GUI 可查看 IM 会话的完整轨迹、甚至直接在 GUI 里代答。

但两类"人机交互 seam"每进程只有一个出口，web profile 下归浏览器：

| 能力 | 并存模式（web profile） | 说明 |
|------|------------------------|------|
| 消息对话 | **两面都可用** ✅ | IM 与 GUI 给同一 Agent 发消息，共享会话上下文 |
| 流式回复 | **两面都可用** ✅ | IM 看流式消息，GUI 看打字效果 |
| ask_user 提问 / plan 审阅 | **仅浏览器** ⚠️ | apiproxy 已注册 provider（唯一）；插件注册失败自动降级；无人开浏览器时提问悬挂 |
| 工具审批 | **仅浏览器** ⚠️ | apiproxy 的 answerer 在瀑布中先注册并短路（找到 `approval/asked` 即接管）；无人开浏览器时审批悬挂 |
| 模型/工具/goal/会话 | 共享 ✅ | 同一运行时 |
| IM 管理命令（`/cwd` `/model` `/allow` 等） | 仅 IM ✅ | 插件自有能力 |

> 并存模式的正确姿势：浏览器作为**监督台/审计台**（看轨迹、代答提问、点审批），IM 作为对话入口。前提是机器人有人值守浏览器；无人值守时提问/审批会挂起，此时应改用形态 B。

#### 形态 B：IM 专用模式（自定义 profile：`dsh-base` + 本插件）—— 全交互走 IM

无 web-app 时 userQuestions provider、approval answerer 全部由插件注册，**提问/审批/plan 审阅全部在 IM 中完成**；无人值守也可正常运行。`/goal` 长任务在 IM 中全程可查。

`dsh plugin` 首次使用会**自动初始化 profile**（bundles 默认就是 `["@deepseek-ai/dsh-base"]`，无需手动创建 package.json）：

```bash
dsh plugin --profile wildfire add @wildfirechat/dsh-wildfire
```

然后编辑 `~/.dsh/profiles/wildfire/cordis.patch.yml` 加入插件行（见「配置参考」），启动：

```bash
dsh --profile wildfire
```

> **必须显式启用 `dsh-tool-ask-user`**（不在任何 bundle 内）：在 patch 的 insert 中加 `- id: tool-ask-user / name: '@deepseek-ai/dsh-tool-ask-user'`，否则 Agent 无 `ask_user` 工具，提问会退化为模型直接发文本。

### 从并存模式（web profile）切换到 IM 专用模式的完整步骤

适用于：无人值守、多人 IM 使用、或希望 ask_user 提问与工具审批在 IM 中完成。

```bash
# 1. 创建 wildfire profile 并安装插件（自动初始化，bundles 默认 [dsh-base]）
dsh plugin --profile wildfire add @wildfirechat/dsh-wildfire
#    或本地 tgz：
#    dsh plugin --profile wildfire add ./wildfirechat-dsh-wildfire-0.1.0.tgz

# 2. 迁移配置：把 web profile 里的插件行复制到新 profile 的 patch 层
#    cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/wildfire/cordis.patch.yml
#    （gatewayUrl / robotId / robotSecret / whiteList / workspace 等配置原样保留，
#      只需确认插件行存在；若 web 侧从未配置过，手工粘贴「配置参考」中的 insert 行）

# 3. 停止 web profile 进程（避免同一机器人两处连接），启动 IM 专用 profile
dsh --profile wildfire
```

**切换时的数据与状态说明**：

| 项目 | 是否迁移 | 说明 |
|------|---------|------|
| 插件配置（gatewayUrl/robotId/…） | 复制 patch 文件 | 步骤 2 完成 |
| DSH 全局设置（模型/凭据/API key） | 无需迁移 | `~/.dsh/settings.yaml` 等跨 profile 共享 |
| 历史会话数据 | 无需迁移（可选恢复） | 会话持久化在 `~/.dsh/sessions`，跨 profile 共享；但 IM 会话按确定性 sessionId **新建**（不 resume），上下文不自动延续。需要旧上下文可暂时切回 web profile 继续 |
| `/cwd` 群目录绑定、`/allow` 名单 | 无需迁移 | 持久化文件在 `~/.dsh/`，跨 profile 共享 |
| 机器人连接 | 需互斥 | 同一 robotId 同时只允许一个连接（网关侧单会话映射），切换前先停旧进程 |

**验证切换成功**：

```bash
# 日志应出现（IM 专用 profile）：
#   [wildfire] userQuestions provider registered (ask_user via IM)
#   [wildfire] approval answerer registered (approvals via IM)
# 而不再出现（并存模式的降级日志）：
#   [wildfire] userQuestions provider already registered (web profile)...
```

功能验证：给机器人发一条触发 Agent 提问的任务（如"问我要不要继续"），提问应出现在 **IM 会话**；触发一次需审批的工具操作，审批消息应发到 **IM**，回复"同意/拒绝"生效。

**回切并存模式**：停掉 wildfire profile，改跑 `dsh web` 即可（配置仍在 web profile 的 patch 层，两 profile 可交替使用，同一时间只跑一个）。

### 从 IM 专用模式（wildfire profile）切换到并存模式（web profile）的完整步骤

适用：希望 `dsh web` 启动时**同时带起 IM 机器人**（GUI 监督 + IM 对话并存）。

> **profile 隔离（为什么 `dsh web` 不会自动带插件）**：DSH 的插件配置按 profile 隔离——
> 插件包装在哪个 profile 的 `node_modules`、patch 配在哪个 profile 的 `cordis.patch.yml`，
> 就只在那个 profile 启动时加载。`dsh web` 等价于 `dsh --profile web`，只加载
> **web profile** 的 bundles（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）与用户 patch，
> **不会**读取 wildfire profile（或其他任何 profile）里安装/配置的插件。因此仅在
> `~/.dsh/profiles/wildfire` 配置过插件时，`dsh web` 起来后插件不会加载——这不是 bug，
> 是 profile 隔离的预期行为，需要把插件也装进 web profile 并在其 patch 层激活。

```bash
# 1. 在 web profile 里安装插件包（任选其一）
#    方式 A：dsh 插件管理（推荐，等价于在 profile 目录执行 pnpm add）
dsh plugin --profile web add ./wildfirechat-dsh-wildfire-0.1.0.tgz
#    方式 B：手动指定本地 tgz（file: 依赖；改包后重装即刷新）
#    在 ~/.dsh/profiles/web/package.json 的 dependencies 加：
#      "@wildfirechat/dsh-wildfire": "file:/path/to/wildfirechat-dsh-wildfire-0.1.0.tgz"
#    并确保 ~/.dsh/profiles/web/pnpm-workspace.yaml 存在（nodeLinker: hoisted，
#    可从 wildfire profile 复制），然后：
corepack pnpm@latest --dir ~/.dsh/profiles/web install

# 2. 激活并配置：编辑 ~/.dsh/profiles/web/cordis.patch.yml，insert 插件行 + tool-ask-user
#    （与 wildfire profile 的配置完全一致；可直接把 wildfire 的 patch 内容复制过来，
#    或参考「配置参考」章节）：
# - insert:
#     - id: tool-ask-user
#       name: '@deepseek-ai/dsh-tool-ask-user'
#     - id: wildfire
#       name: '@wildfirechat/dsh-wildfire'
#       config:
#         gatewayUrl: ws://.../robot/gateway
#         robotId: ...
#         robotSecret: ...

# 3. 停旧进程（同一 robotId 同时只允许一个网关连接，先停 IM 专用模式），重启 dsh web
pkill -f "dsh --profile wildfire"
dsh web
# 日志出现 [wildfire] connected as <robotId> 即插件加载成功
```

验证：野火客户端给机器人发消息正常回复；浏览器 GUI 同时可用（同一 Agent 运行时，会话互通）。
可用 `dsh --profile web --dump-config | grep wildfire` 检查组合树里插件行是否就位。

> 两 profile 可长期并存、交替使用，**同一时间只跑一个**（机器人连接互斥）。

#### 选型建议

| 场景 | 推荐形态 |
|------|---------|
| 自用机器人、偶尔要看 Agent 轨迹 | A（并存，web profile） |
| 无人值守/多人 IM 使用、审批要在 IM 完成 | B（IM 专用） |
| 既想 GUI 监督又想让 IM 用户答提问/审批 | **暂不支持**（userQuestions provider 每进程唯一；可提需求实现"插件接管 provider + GUI 只读"） |

## 安全设计

把一台带完整工具链（bash/文件系统/网络/子代理）的 Agent 开放给 IM 用户，安全是首要问题。本节给出威胁模型、DSH 侧安全基线与插件侧加固。

### 威胁模型

| 威胁 | 攻击面 | 缓解 |
|------|--------|------|
| **提示注入**：用户消息诱导 Agent 执行危险 bash、读敏感文件、外传数据 | 用户文本直接进 `agent.followup`；图片附件内容、ASR 转写、ask_user 回复同理 | ① DSH 沙箱策略（见下）是**唯一可靠的文件围栏**；② 工具审批（IM 同意/拒绝）；③ 出站媒体路径围栏（防 `[image:/etc/passwd]` 外传）；④ 工作目录按群隔离缩小爆炸半径 |
| **旁观者劫持审批/提问**：群里任何成员替发起者放行危险操作 | 审批/提问回复仅按会话 key 匹配 | 已修复：pending 交互绑定 **turn 发起者**（`turnOwners`），旁观者回复不被消费（管理员除外） |
| **任意文件外传**：注入让 Agent 输出 `[image:/etc/passwd]` | 出站媒体标记读取本地文件上传 IM | 已修复：realpath 校验，仅允许会话工作目录 + `workspace.allowedRoots` 内的文件（含 symlink 逃逸防护） |
| **工作目录越权**：`/cwd` 绑定任意路径（如他人 home） | `/cwd <path>` 仅校验目录存在 | `workspace.allowedRoots` 必配（realpath 围栏）；`/cwd` 仅群主/管理员可执行 |
| **成本滥用**：高频消息烧模型 API 额度 | 无限频 | `security.maxMessagesPerMinute` 滑动窗口限频（建议配置） |
| **机器人凭据泄露** | `robotSecret` 明文在 profile 配置 | 配置文件权限 600；robotSecret 不进日志 |
| **恶意文件**：用户发图片/文件给 Agent | 下载后 attachment/路径入 Agent | 扩展名白名单（safeExt）；attachment 服务校验 PNG/JPEG/WebP/GIF；临时文件回合后清理 |
| **数据隐私**：对话内容、用户文件落在 DSH 会话存储与日志 | 本地磁盘 | 与 DSH 同等信任域；日志仅 `safePreview`（压缩空白防注入）；敏感部署建议 `media.downloadDir` 与 `~/.dsh` 用加密盘 |

### DSH 侧安全基线（必读）

DSH 的沙箱策略（`dsh-sandbox-policy`）是**文件安全的唯一硬围栏**，默认 `read-only`（fail-safe）。`workspace-write` 模式下只允许写会话 cwd——本插件每群独立目录天然契合。推荐在 profile patch 中显式配置：

```yaml
# 代码助手型机器人（推荐）
- id: sandbox-policy
  config:
    mode: workspace-write        # 只写会话工作目录

# 纯问答型机器人（最严格）
- id: sandbox-policy
  config:
    mode: read-only              # Agent 不能修改任何文件
```

> 注意：插件层的 `workspace.allowedRoots` 只约束"用户能把会话绑到哪些目录"，**不约束 Agent 能访问哪些文件**——后者由 DSH 沙箱负责。二者必须配合使用。

工具审批策略（`dsh-user-approval`）默认 `ask`，本插件把审批转发到 IM；若希望更严格可在 DSH 侧把审批策略设为 `never`（全部拒绝需审批操作）。

### 插件侧安全机制清单

| 机制 | 配置 | 默认 |
|------|------|------|
| 白名单准入 | `whiteList` | 关闭（全员可用） |
| 管理命令权限 | `access.adminUsers/adminGroups` + 群主 | 未配置管理员时全员可执行命令（建议显式配置） |
| 工作目录围栏 | `workspace.allowedRoots` | 空（无限制，建议必配） |
| 出站媒体围栏 | 内建（cwd + allowedRoots，realpath） | 始终生效 |
| 审批/提问身份校验 | 内建（turn 发起者） | 始终生效 |
| 速率限制 | `security.maxMessagesPerMinute` | 0（关闭，公开机器人建议 5~10） |
| 审批超时 | `interaction.approvalTimeoutMs` | 120s → `cancelled`（fail-closed） |
| ask_user 超时 | `interaction.askUserTimeoutMs` | 300s |

### 部署安全清单

- [ ] 配置 `sandbox-policy`（`workspace-write` 或 `read-only`），不要使用 `danger-full-access`
- [ ] 配置 `workspace.allowedRoots`（如 `["/data/projects"]`）
- [ ] 配置 `access.adminUsers` / `adminGroups`（或接受"全员可执行命令"的风险）
- [ ] 公开机器人配置 `security.maxMessagesPerMinute` 与 `whiteList`
- [ ] profile 配置文件权限 `chmod 600`（含 robotSecret）
- [ ] 部署为 IM 专用 profile（`dsh-base` + 插件），IM 用户无法触碰 web GUI
- [ ] `media.downloadDir`、`~/.dsh` 所在磁盘的访问权限确认

### 已知限制（残余风险）

- **提示注入无法根除**：Agent 本质是执行用户意图，沙箱+审批是防御深度而非免疫。高风险机器人建议 `read-only` + 审批 `never` + 白名单
- 群聊中 ask_user 提问消息对全员可见（问题本身可能泄密）；审批仅发起者可答，但管理员始终可替答
- `security.maxMessagesPerMinute` 按会话计数，攻击者可用多会话绕过（配合 `whiteList` 使用）
- ASR 服务、野火网关、IM 服务器在插件信任域内，其安全由各自运维负责

## 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 机器人网关协议与 SDK
- [OPENCLAW_INTEGRATION.md](./OPENCLAW_INTEGRATION.md) — OpenClaw 对接（本设计的模式来源）
- [openclaw-plugin.js/README.md](./openclaw-plugin.js/README.md) — OpenClaw 插件实现细节
- [dsh-plugin.js/README.md](./dsh-plugin.js/README.md) — 本插件安装与使用
- DSH 源码：`@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`（`node_modules/@deepseek-ai/*/README.md`）

---

**文档版本**：1.0
**最后更新**：2026-02-01
