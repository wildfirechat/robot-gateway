# 野火IM × DeepSeek Harness 交互与隔离设计（官方原生版）

> 本方案由野火 IM 官方设计，可修改 im-server / 客户端 / robot-gateway / DSH 插件全部代码。
> 消息类型并入官方类型体系（**200-209 号段，200 段整体预留给 AI 交互**），客户端原生渲染，无协商/迁移/历史兼容约束。

## 1. 目标

把 IM 从"文本聊天界面"升级为 **DSH Agent 的原生交互终端**：

- **结构化交互**：提问/审批/进度/状态用原生消息类型承载，客户端渲染为卡片 + 按钮
- **状态可见**：Agent 生命周期（思考/工具/等待输入/完成）显式推送到 IM
- **无歧义响应**：按钮点击产生结构化应答（带一次性 ID），不依赖文本解析
- **工作区隔离**：每个 IM 对话（私聊/群）= 一个隔离的工作区（目录 + Agent 会话 + 权限 + 配额）

## 2. 消息协议（官方类型扩展）

### 2.1 类型号段

野火官方现有类型占用（完整清单）：**1-19、21-26、31、32、40、41-47、71-73、80-94、100、104-125、400-417、501/502、510/511、610-613**（含文本/媒体/流式/通知/VOIP/朋友圈等）；**126-399 整段目前无人占用**。**本方案占用 200-209 段**（**200 号段整体预留给 AI 交互**，后续 AI 类型持续扩展）。

> 野火类型号段约定：**<1000 为官方保留**（含 200 段，作为官方 AI 交互预留，须随新版客户端 SDK 一起发布）、**≥1000 为第三方自定义**。200 段作为官方预留不影响既有第三方自定义消息生态。

| 类型 | 名称 | 方向 | 说明 |
|------|------|------|------|
| 200 | `DSH_Question` | 机器人→用户 | 提问卡片（含选项） |
| 201 | `DSH_Answer` | 用户→机器人 | 结构化回答 |
| 202 | `DSH_Approval` | 机器人→用户 | 工具审批卡片 |
| 203 | `DSH_ApprovalResult` | 用户→机器人 | 审批结果 |
| 204-205 | ~~`DSH_Progress`/`DSH_Status`~~ 已废弃 | - | 进度/状态改走 **scope=31 会话级用户设置**（见 2.2 末），不占消息类型 |
| 206 | `DSH_Goal` | 机器人→用户 | 目标进度卡片 |
| 207-209 | 保留 | - | 扩展（如 DSH_ToolResult、DSH_Command） |

客户端 SDK 的 `MessageContentType` 常量同步扩展（200-209 段约定归 AI 交互使用）；im-server 对自定义 payload 透传（官方默认行为，确认即可）。

> 注意：插件 inbound 已放行 200-209 段并分发处理（201/203 结构化应答直接消费，群通知 104-125 段在白名单/限流/分发之前拦截）；未匹配的 DSH_* 类型丢弃。

### 2.2 Payload 结构

统一约定：`payload.searchableContent` 为摘要文本（搜索/通知可见），`payload.content` 为结构化 JSON。

**DSH_Question (200)** — 由 DSH `userQuestions` 服务事件映射（DSH 原生支持多问题，协议用数组对齐）：
```json
{
  "qid": "uuid",                // 一次性，防重放
  "questions": [
    {
  "header": "需要你确认",
  "question": "是否继续执行？",
  "detail": "该操作会修改 3 个文件",
  "options": [{"label": "是"}, {"label": "否"}],
  "multiSelect": false,
  "intent": {"kind": "plan-review", "approve": "批准"}   // 可选：对象而非字符串；DSH 校验 approve 须命中选项且须配 detail，否则 BAD_INTENT
    }
  ]
}
```

**DSH_Answer (201)** — 客户端按钮/输入产生（多问题按 qid 对应）：
```json
{ "qid": "uuid", "answers": [{"id": "q1", "selected": ["是"], "custom": "可选补充文本"}] }
```

**卡片期间用户直接发文本**（不点按钮）：视为对 pending 卡片的**自定义回答**（`answers[].custom`），与 DSH userQuestions 的 custom 语义一致；若已过期（turn 结束/超时）则按普通消息处理。

**多问题映射约束**：DSH 一次 `ask()` 的多个问题由**同一次 provider 调用返回**——必须渲染为**一张卡片**（`questions[]` 多问题），不得拆成串行多张卡片；插件 pending 表按会话仅一个，天然与"一次 ask 一张卡片"对齐。

**DSH_Approval (202)** — 由 DSH `approval/request` 映射：
```json
{ "aid": "uuid", "toolName": "bash", "reason": "运行 rm -rf ./dist" }
```

**DSH_ApprovalResult (203)**：
```json
{ "aid": "uuid", "action": "approve" }   // 或 "reject"
```

**进度/状态通道（scope=31 会话级用户设置，替代原 204/205 消息）** — 由 `turn/start`、`step/start`、`tool/call`、`turn/end` 事件映射，经 `updateConversationUserSetting`（scope=31）推送，300ms 合并节流；**不落消息流、不产生历史堆积**。**双通道设计**：运行/交互状态走 **type=1**（键 `..._1`，高频瞬态，每次推送携带自上次以来的完整合并状态），Token 统计走 **type=2**（键 `..._2`，低频累积、回合结束必推含出错/取消，带 `metricsAt` 时间戳）——统计不受状态推送路径影响。

**type=1 运行/交互状态**
```json
{ "state": "idle" | "running" | "waiting_user" | "done",
  "phase": "thinking" | "tool" | "done", "toolName": "bash",
  "model": "deepseek-official/deepseek-v4-flash", "reasoningEffort": "high",
  "interaction": "question" | "approval",        // state=waiting_user 时有效
  "reason": "completed" | "error" | "cancelled", // 上回合结果；新回合开始（state=running）时清除
  "error": "错误信息",                            // reason=error 时
  "cwd": "/data/wf/<id>/", "sessionId": "wildfire-<hash>",
  "goal": { "phase": "active|paused|blocked|complete", "roundsStarted": 3, "objective": "..." } }
```

**type=2 Token 统计（来源：DSH dsh-token-meter 投影，provider 真实计数；插件在回合结束时快照差分）**
```json
{ "usage":   { "promptTokens": 323, "outputTokens": 181, "cacheReadTokens": 15488, "cacheWriteTokens": 0, "totalTokens": 15992 },
  "turn":    { "inputTokens": 102, "outputTokens": 179, "cacheHitTokens": 7808, "durationMs": 2540 },
  "context": { "usedTokens": 8113, "windowTokens": 1000000, "usedPct": 0.8 },
  "cacheHitRatePct": 98,
  "speed":   { "tokensPerSec": 70.5, "ttftMs": 2227 },
  "metricsAt": 1787470162762 }
```

字段语义（客户端展示约定）：
- `usage`：会话累计用量（uncachedInput/output/cacheRead/cacheWrite 四桶，output 含 reasoning）
- `turn`：本轮增量（快照差分）+ 本轮耗时（插件本地计时）
- `context`：上下文占用 —— `usedTokens` 是"下一请求预估 prompt 成本"（projectedTokens，能反映压缩回落），`usedPct = usedTokens/windowTokens`；窗口默认 1M（deepseek）
- `cacheHitRatePct`：累计缓存命中率 = cacheRead/(cacheRead+uncachedInput)；多轮会话才有意义，首轮通常 0%
- `speed`：本轮生成速度（输出 token/耗时）与首字延迟，插件本地计时，非 provider 上报
- `metricsAt`：统计生成时间（Unix ms），客户端据此判断时效
- 客户端标题合并行 = **AI 在线（type=1 群主在线）· 运行态提示（type=1：🤔 等待确认/🔐 等待审批/⚠️错误/已取消）· 统计（type=2：上下文 0.8% · 缓存 98% · 70.5 tok/s · 本轮 179 tok · 累计 15992 tok）**，各段为空则跳过（参考各端 `dshMetricsText` + `dshStatusHint`）

> 决策原因：进度/状态是高频瞬态数据，作为消息发送会堆积历史且透传消息（messageId=0）在客户端消息列表中不可见；会话级用户设置天然是"当前状态"语义，客户端订阅即得。Token 计量走同一通道，客户端无需额外查询。

**DSH_Goal (206)**：
```json
{ "gid": "<GoalRef>", "objective": "...", "phase": "active|paused|blocked|complete", "roundsStarted": 3 }
```

### 2.3 卡片更新（官方能力复用）

- 发送卡片后，状态变化用 **`updateMessage`**（RobotService 已有 API）原地更新同一卡片：
  - 审批卡片：`pending` → `approved/rejected/expired`（按钮置灰）
  - 提问卡片：`pending` → `answered/expired`（选项置灰）
- 客户端对 200/202/206 类消息渲染"可交互卡片"，收到同 `messageId` 的更新消息时刷新 UI（而非追加新消息）
- 进度/状态不走消息，由 scope=31 会话级用户设置承载（见 2.2），客户端订阅该设置渲染状态条/徽标

### 2.4 消息持久化策略（persistFlag）

野火消息持久化由 payload 的 `persistFlag` 控制（0=不存 / 1=存 / 3=存且计数 / 4=透传）：

| 类型 | persistFlag | 理由 |
|------|-------------|------|
| 200 `DSH_Question`、202 `DSH_Approval`、206 `DSH_Goal` | 1（存） | 卡片需持久化，重启后仍可展示/审计 |
| 201 `DSH_Answer`、203 `DSH_ApprovalResult` | 1（存） | 应答留痕 |
| 进度/状态（scope=31 用户设置） | 不适用 | 会话级用户设置，非消息，无历史堆积问题 |

### 2.5 客户端渲染规范

- `DSH_Question`：卡片 + 选项按钮（单选/多选）+ 自定义输入框；`intent=plan-review` 时渲染计划审阅样式（detail 计划全文 + 批准/拒绝按钮）
- `DSH_Approval`：卡片 + 同意/拒绝按钮 + 原因展示
- 进度/状态（scope=31）：DSH 群的会话头部状态徽标（模型、工作区、运行/等待状态）、会话列表状态圆点、思考/工具内联提示；**仅 DSH 群（群 extra 含 `{"dsh":true}`）展示**，普通群不显示
- 输入框占位随状态变化（`waiting_user` 时提示"可直接输入文字回答，或点击上方卡片按钮"）
- 单聊机器人会话提供控制面板命令快捷条（/help /create-group /workspaces /goal /jobs /stop 等）

## 3. 交互状态机

DSH Agent turn 生命周期显式推送到 IM：

```
idle ──收到消息──▶ running ──▶ waiting_user ──应答──▶ running ──▶ done
                    │  thinking/tool                    │
                    └── progress 流 ────────────────────┘
```

| 状态 | 推送 | 客户端表现 |
|------|------|-----------|
| `idle` | scope=31 `state=idle` | 正常输入 |
| `running` | scope=31 `state=running`（含 phase=thinking/tool、toolName） | 状态条/思考动画 |
| `waiting_user` | `DSH_Question` / `DSH_Approval` 卡片 + scope=31 `state=waiting_user` | 输入框**不禁用**，占位提示"可直接输入文字回答，或点击上方卡片按钮"（文字=自定义回答） |
| `done` | 流式 completed + scope=31 `state=done` | 完成 |

群聊中：进度与卡片**仅推送给发起者**（本方案无需 im-server 定向能力：群默认"仅群成员邀请"保证成员可信，卡片/进度在群内对全员可见，交互仅发起者有效——见 4.1 授权模型）。

## 4. 工作区 / 会话隔离设计

### 4.1 工作区模型（群 = 工作区，单聊 = 控制面板）

**只有群是工作区**；单聊机器人会话是**控制面板**（系统级操作，不承载工作区）：

```
工作区（= 一个 DSH 群）
├── workspaceId = 确定性（sha256(groupConversationKey) 前 20 位，与 DSH sessionId 一致）
├── 群标记    群 extra 含 JSON: {"dsh": true} —— 标识这是 DSH 工作区群
├── 工作目录  /data/wildfire-workspaces/<workspaceId>/
│   ├── files/          # Agent 文件（bash/fs 工具的工作区）
│   └── .meta/          # 工作区元数据（创建者、配额、说明）
├── DSH Agent 会话 sessionId = wildfire-<hash>（resume 持久化，上下文延续）
├── 权限（授权模型，见下）
├── 配额
│   ├── 并发    每会话串行队列（1 在途）    ✅ 已有
│   ├── 频率    security.maxMessagesPerMinute ✅ 已有
│   └── 扩展    token/时长配额（可选）
└── 生命周期
    ├── 创建     建群 + 群 extra 标记 dsh（客户端引导创建"DSH 工作区群"）
    ├── 懒激活   创建者首条消息 → 建目录 + 建会话
    ├── 活跃     正常对话
    ├── 回收     空闲超时 → session dispose（✅ 已有 sweep）
    └── 归档     群解散 → 目录归档/清理（监听 DismissGroup 108）
```

**单聊控制面板**（机器人私聊，非工作区）：
- 系统操作命令：`/create-group`（创建 DSH 工作区群，含工作区选择）、`/destroy-group <groupId>`（销毁工作区群）、`/workspaces`（列出所有 DSH 群及状态）、`/new <groupId>`（重置指定群会话）、`/model`、`/cwd`、`/allow`、`/goal`（创建/查看/暂停/恢复目标）、`/jobs`（汇总所有存活会话的后台任务进度）、`/stop`（停止当前会话正在运行的任务，私聊+群聊均可用）、`/help`（命令帮助，按权限过滤）
- **单聊普通文本**（非命令）：走 Agent 的**全局助手会话**（cwd=控制面板专用目录，不落任何工作区）——用于"问一个问题但不属于某个群"的场景；回复提示"此对话不关联工作区，如需工作区请使用对应群"
- 控制面板会话独立（不与其他群工作区共享上下文）

**标识派生统一公式**（目录名 / workspaceId / sessionId 三者的唯一关系）：

```
conversationKey  = "wildfire:group:<groupId>"（小写）
workspaceId      = sha256(conversationKey)[:20]      # 工作区唯一标识
sessionId        = "wildfire-" + workspaceId         # epoch>0 时追加 "-<epoch>"（会话重置后）
工作区目录        = <workspaceRoot>/<workspaceId>/     # 自动分配时即此目录，非 groupId
持久化日志        = ~/.dsh/sessions/--<normalized-cwd>--/<encoded-sessionId>/session.jsonl.zstd
```

> 目录名、workspaceId 与 sessionId 前缀严格同源；`/cwd` 命令的 `peekSessionId()` 亦用此公式。

### 4.1.1 群授权模型（仅群成员邀请 + 群成员全员可交互）

群加入方式**仅"成员邀请"**（ChangeJoinType）——群里都是可信成员，因此**群内所有成员的指令都执行**，无需额外授权流程：

| 角色 | 行为 | 说明 |
|------|------|------|
| **群成员** | 可交互 | 群内所有成员的 @机器人/消息触发 Agent（按群聊触发策略） |
| **创建者**（发起 `/create-group` 的用户） | 可交互 + 可管理 | 可执行 /cwd /model /effort /reset 等管理命令（插件持久化 creatorUserId 校验，见下） |
| **机器人 owner** | 超级权限 | 任何群可管理（getProfile 获取） |
| **非群成员** | 不可进入 | 群加入类型"仅群成员邀请"，杜绝陌生人混入 |

> **重要：IM 层群主是机器人自己**（`createGroup` 时 im-server 把 owner 硬设为机器人 uid），因此**管理权限不使用 IM 群主概念**，改用**创建者**：插件在 `/create-group` 时持久化 `creatorUserId`（落盘），管理命令校验创建者身份。

群 `extra` JSON（标识 + 记录）：
```json
{ "dsh": true }
```
- 仅需布尔标记；成员权限 = IM 群成员关系（全员可交互）+ 插件持久化的创建者（可管理），无需 extra 记录角色
- 全局兜底：`whiteList` 保留（owner 可用它全局禁用某个用户/群，作为 DSH 层之上的管理闸门）

### 4.1.2 创建 DSH 工作区群（单聊命令，机器人创建群）

创建入口收敛到**单聊命令**：由机器人通过 RobotService 创建群（`createGroup`），保证群标记/成员/加入类型正确，避免客户端手工建群遗漏步骤：

```
用户(单聊) → /create-group [工作区参数]
机器人 → RobotService.createGroup：
         群名（如 "DSH-工作区-<n>" 或用户指定）
         成员 = 发起用户 + 机器人自己（必须，否则消息不推送）
         群 extra = {"dsh": true}
         加入类型 = 仅成员邀请
       → 分配/校验工作区目录（见 4.1.3）
       → 回复群信息（groupId/群名/工作区路径）
用户 → 客户端搜索/进入该群，开始使用（首条消息激活工作区）
```

权限：仅**机器人 owner** 或配置的 `adminUsers` 可执行（创建群=资源分配，需管理员授权）。

**DSH 群注册表（生效判定的唯一依据）**：im-server 的权限模型允许任意群成员修改群 extra，`{"dsh": true}` 标记在 IM 层**无法防篡改**。因此插件持久化一个**"由我创建的 DSH 群"注册表**（`groupId` 集合，落盘，含 creatorUserId），生效判定 = **注册表命中**；`extra` 仅作为客户端 UI 的冗余标识（机器人创建时写入，普通群手工标记无效）。

| 判定来源 | 角色 |
|---------|------|
| **插件注册表**（落盘） | 生效判定的**唯一依据**——防手工标记 |
| 群 `extra` | 仅客户端 UI 冗余标识（机器人创建时写入） |

机器人侧：仅在处理 **extra 含 dsh 标记的群**消息时生效（非 DSH 群消息忽略，避免普通群被误触发）。

### 4.1.3 工作区选择方案（用户在 IM 中选定目录）

IM 无法弹文件选择器，工作区目录通过以下**三级方案**选定（按优先级）：

| 方式 | 用法 | 说明 |
|------|------|------|
| **① 自动分配（默认）** | `/create-group` | 目录 = `/data/wildfire-workspaces/<workspaceId>/`（= 标识公式中的工作区目录，非 groupId），无感创建 |
| **② 预配置目录目录（catalog）** | `/create-group`（列目录）→ 用户回复编号 | 管理员在配置中预定义可选目录：`workspace.catalog: [{id, path, label}]`；`/create-group` 无参时列出 catalog 供用户选 |
| **③ 显式路径** | `/create-group /data/projects/repo-a` | 路径必须存在且位于 `allowedRoots` 内（realpath 校验） |

选定后绑定：`workspace.overrides[groupId] = <目录>`（复用现有 /cwd 持久化机制），群内成员不可改（管理命令仍可 `/cwd` 切换，需创建者/owner 权限）。

### 4.1.4 会话销毁 / 关闭逻辑

三个层次的"关闭"语义必须区分清楚：

| 层次 | 触发 | 行为 | 数据 |
|------|------|------|------|
| **会话重置** | 群内 `/reset`、单聊 `/new <groupId>` | Agent 上下文清空（epoch++ 重建会话） | 保留工作区目录；旧持久化日志保留 |
| **会话回收** | 空闲超时（sweep） | dispose Agent（释放内存） | 保留持久化；resume 可恢复 |
| **工作区销毁** | 单聊 `/destroy-group <groupId>`；群解散（108） | dispose Agent + **删除工作区目录** + 清理状态 | 数据删除 |

**工作区销毁流程**（`/destroy-group` 与群解散共用）：

```
触发（命令：机器人 dismissGroup 后；或 108 群通知）
  → dispose 该群 Agent 会话（agents.dispose）
  → 清理内存状态：sessions / turnOwners / rateWindows / 交互 pending
  → 删除工作区目录（/data/wildfire-workspaces/<workspaceId>/，含 files/.meta）
  → 清理 workspace.overrides 绑定（可选保留）
  → 移除群标记（若群未解散）
  → 单聊回执：群已销毁，工作区已删除
```

**权限**：`/destroy-group` 仅 机器人 owner / adminUsers（销毁=删除数据，最高权限）。

**DSH 侧说明（能力边界）**：DSH 当前**无"删除持久化 session"的官方 API**（dsh-workspace 明确 session deletion 是缺失能力）。因此：
- Agent 会话 dispose 后，`~/.dsh/sessions/` 下的 JSONL 日志**物理保留**（历史审计）
- 工作区目录删除后，同 id 再次 create 不受影响（确定性 id 可复用）
- 如需彻底清除会话日志，由部署层手动清理 `~/.dsh/sessions/--<normalized-cwd>--/<encoded-sessionId>/` 目录（cwd 目录带 `--` 前后缀、sessionId 做路径转义、日志为 zstd 压缩的 `session.jsonl.zstd`，非纯文本 JSONL）

### 4.2 隔离层次（关键设计）

| 隔离层 | 机制 | 状态 |
|--------|------|------|
| **上下文隔离** | 每工作区独立 DSH session（确定性 id + resume） | ✅ 已有 |
| **写隔离** | DSH sandbox `workspace-write`：Agent 只能写本工作区 cwd | ✅ 已有（需 profile 配置） |
| **读隔离（默认信任模型）** | 不做 OS 层拦截；依赖"群成员互信" | 默认 |
| **读隔离（强多租户）** | 每租户独立 DSH 进程 + 独立 OS 用户，或容器 | 🔶 部署方案 |
| **消息可见性** | IM 会话天然隔离（用户只看到自己会话的消息） | ✅ IM 天然 |
| **管理隔离** | 白名单 + admin/创建者门控 | ✅ 已有 |
| **网络隔离** | 出站网络限制（防火墙/代理白名单，可选） | 🔶 可扩展 |

**写隔离是核心**：`dsh-sandbox-policy` 配置 `workspace-write` 后，bash/fs 工具的文件修改被限制在**当前会话 cwd**（即本工作区目录）内——工作区 A 的 Agent 物理上无法修改工作区 B 的文件（即使同机同用户）。这是多群多用户共用一个 DSH 进程时的安全底线。

**读隔离边界（诚实说明）**：sandbox 的 `workspace-write` 只限制**写**，**读不限制**——同进程 Agent 理论上可读同机其他工作区目录。缓解：
- 信任模型（默认）：群成员互信，读到其他工作区文件仅信息泄露风险低
- 强隔离（多租户）：每租户独立进程/OS 用户（读隔离靠 OS 权限），或未来 DSH sandbox 增加 read-root 能力

### 4.3 目录布局与 DSH 配合

```
/data/wildfire-workspaces/          # 根（对应 workspace.allowedRoots）
├── <workspaceId-A>/                # DSH 群 A
│   ├── files/ ...                  # Agent 产出
│   └── .meta/workspace.json        # 元数据（创建者/配额）
└── <workspaceId-B>/ ...            # DSH 群 B
```

- 每个工作区目录 = Agent 会话的 `cwd`（create/resume 时写入 session header）
- DSH 会话持久化（`~/.dsh/sessions/`）已按 cwd 分目录，天然隔离
- `workspace.allowedRoots: ["/data/wildfire-workspaces"]` + `/cwd` 命令的 realpath 围栏 → 用户无法把 Agent 绑到根目录外

### 4.3.1 群通知拦截顺序（实现约束）

插件的 inbound 过滤器放行 104-125 群通知段与 200-209 DSH 段（`payloadType > 15 && < 100` 与 `> 209` 被跳过）。**实现 §4.4 销毁逻辑的强制顺序约束**：

```
inbound 消息 → 先拦截通知类型（105 AddGroupMember / 108 DismissGroup 等）
            → 命中则走生命周期处理（注册表更新/工作区销毁），绝不进入 Agent dispatch
            → 其余类型才进入正常流程（文本/卡片应答/DSH_* 消息）
```

否则 105/108 会被当作"暂不支持的消息类型"甚至 dispatch 给 Agent，破坏销毁语义。

### 4.4 生命周期事件（IM 原生）

| 事件 | 处理 |
|------|------|
| `/create-group`（单聊命令） | 机器人 createGroup（成员=用户+机器人、extra dsh、仅成员邀请）+ 工作区选择（4.1.3）+ **写入 DSH 群注册表**（groupId+creatorUserId，落盘） |
| 群首条消息 | 工作区激活（建目录+建会话，懒） |
| 群成员变动（105） | 成员加入 → 自动可交互（IM 群成员关系即授权，无需插件干预） |
| 群解散（108） | 工作区销毁（4.1.4） |
| `/destroy-group`（单聊命令） | 机器人 dismissGroup + 工作区销毁（4.1.4） |
| 空闲 | 会话回收（sweep，✅ 已有：仅释放内存，保留持久化） |
| 进程重启 | 连接重连 + 会话 resume（✅ 已有） |

> 按决策：**不处理**机器人被移除（106）与换群主（109）——群成员关系由 IM 管理，插件不感知；若需这些语义，后续可作为增量。

### 4.5 多租户扩展（暂不实施）

> 按决策：**暂不考虑多租户**。读隔离采用默认信任模型（群成员互信），单 DSH 进程 + `workspace-write` 写隔离即为安全基线。
> 未来若需服务互不信任客户：每租户独立 DSH 进程（独立 profile/工作目录/OS 用户）+ 独立机器人（进程级隔离）；调度由 im-server 或上层按 tenant 路由到对应机器人（野火多机器人天然支持）。

## 5. 安全设计

| 项 | 措施 |
|----|------|
| 防重放 | qid/aid 一次性随机 ID；卡片应答校验 ID 且仅一次 |
| 身份 | 群成员全员可交互（群成员关系=授权）；管理命令仅创建者/owner；卡片应答绑定发起者 |
| 超时 | 卡片过期（turn 结束/超时）→ updateMessage 标记 expired，按钮失效 |
| 文件 | 出站媒体 realpath 围栏（已有）；工作区写隔离（sandbox） |
| 沙箱 | 部署默认 `sandbox-policy.mode`（fail-safe `read-only`）；`/sandbox` 命令按会话切换（决策 13，权限门控=管理命令），**升级到 `danger-full-access` 属危险操作，仅创建者/管理员可执行**；Agent 需更高权限时走审批卡片（202）逐次放行 |
| 注入 | 提示注入无法根除；sandbox + 审批 + 限频为纵深防御（已有） |
| 审计 | 卡片交互全链路可审计（DSH session 日志天然记录） |

## 6. 实现分层与改动面

| 层 | 改动 | 工作量 |
|----|------|--------|
| **客户端 SDK** | `MessageContentType` 扩展（200-209 段，归 AI 交互）；`DSH_*` Content 类（encode/decode） | 小 |
| **im-server** | 确认自定义类型透传；群 extra 字段读写支持（DSH 标记）；群加入类型默认"仅成员邀请" | 小 |
| **客户端 UI** | 卡片渲染 + 按钮交互 + updateMessage 刷新 + 群内状态条 + 单聊控制面板（命令面板） | 中 |
| **DSH 插件** | 事件适配层（session/event + userQuestions/approval → DSH_* 消息）；状态机；群识别与授权；工作区创建/选择/销毁（createGroup/dismissGroup/目录管理） | 主要 |
| **robot-gateway** | 透传（零改动）；确认 updateMessage 代理已支持 | 无/极小 |

**DSH 插件适配层映射表**：

| DSH 事件/服务 | IM 消息 |
|--------------|---------|
| `userQuestions` provider ask | `DSH_Question` (200) |
| `DSH_Answer` (201) 应答 | → 结构化 answer 回填 userQuestions |
| `approval/request` | `DSH_Approval` (202) |
| `DSH_ApprovalResult` (203) | → `allowed-once`/`rejected` |
| `turn/start`、`step/start`、`tool/call` | scope=31 状态推送（state=running，phase/toolName） |
| `assistant/chunk` | 流式（generating→completed，已有） |
| turn/end | scope=31 `state=done` + 卡片过期（updateMessage） |
| goal 事件 | `DSH_Goal` (206) |
| 群注册表校验 | 仅处理插件注册表命中的群（见下）；群成员消息触发；创建者命令管理；非 DSH 群忽略 |

## 7. 决策记录与开放问题

### 已定决策

| # | 决策 |
|---|------|
| 1 | 类型号段 **200-209**，200 段整体预留给 AI 交互 |
| 2 | **群 = 工作区**；单聊 = 控制面板（系统操作，非工作区）；无需群聊定向推送 |
| 3 | 群默认**仅群成员邀请**（ChangeJoinType）；**群成员全员可交互**（无需长按授权）；管理命令仅**创建者**/owner（IM 群主=机器人自身，故用创建者替代） |
| 4 | 群 `extra` JSON 标记：`{"dsh": true}` 标识 DSH 群；成员权限由 IM 群成员关系表达 |
| 5 | **工作区管理 UI：单聊控制面板 + 群内状态展示**（不做独立侧边栏视图；可选二期：群列表状态徽标） |
| 6 | **群创建收敛到单聊命令**：机器人 `createGroup` 创建（成员=用户+机器人、extra 标记、仅成员邀请），工作区三级选择（自动 / catalog / 路径） |
| 7 | **状态/进度推送节流 300ms+ 合并**（复用流式节流机制；经 scope=31 用户设置推送，非消息） |
| 8 | **暂不实施多租户**；读隔离 = 默认信任模型 |
| 9 | **新增工作区销毁**：`/destroy-group` 命令 + 群解散（108）共用销毁流程；`/reset`/`/new` 为重置（保留数据）、sweep 为回收（保留持久化） |
| 10 | **不处理**机器人被移除（106）/换群主（109） |
| 11 | **生效判定 = 插件 DSH 群注册表**（groupId+creatorUserId 落盘）：IM 层群 extra 可被任意成员篡改，不可作为判定依据；extra 仅 UI 冗余标识；普通群手工标记无效 |
| 12 | **模型来源 = DSH 运行时目录**：可选模型来自 `ctx.llm.listProviders()` + `listModels()`（与 web UI 模型选择器同源），`model.allowed` 预设降级为**可选快捷方式**；`/model` 只切模型（**保留当前推理等级**），`/effort` 只调推理等级（按 `llm.resolveModelInfo` 暴露的 effort 列表校验）；裸模型 id 多 provider 重名时要求消歧 |
| 13 | **沙箱模式可按会话运行时切换**：`/sandbox [mode]`（私聊=管理员，群=创建者/管理员）通过 `setSandboxMode` 写入**会话日志的 `sandbox/mode` 事件**——重放即状态，随 resume 持久化，下一次工具调用生效；不依赖 profile 静态配置，`ctx.sandboxPolicy.defaultMode` 为部署兜底 |
| 14 | **斜杠命令优先级最高**：任何以 `/` 开头的消息视为命令——**跳过群触发策略**（无需@/问号/关键词，否则 `/cwd /path` 这类无触发词命令会被静默丢弃）且**不消费为 pending 卡片的文本应答**；未启用的功能命令与未知命令均给出**明确提示**（不再静默吞消息） |
| 15 | **PC 端 DSH 会话 UI**：输入框输入 **`/` 弹出命令菜单**（Tribute，与 `@` 提及同机制；选中命令填入输入框、不直接发送）；标题栏**状态徽标 + 停止按钮**（发 `/stop`）；输入框占位随状态变化（`waiting_user` 提示可直接文字作答）；会话列表**状态圆点 + 群 DSH 标识**——全部仅对 DSH 会话显示，事件驱动（`settingUpdate`）无轮询 |
| 16 | **项目根目录 + 目录浏览 + 缺失目录创建确认**：`workspace.root` 为唯一项目根（回退链 `autoRoot` → 第一个 `allowedRoot` → `path`）；`/cwd` 相对路径一律按根目录解析；新增 `/ls [子目录]` 列出根目录内容（任一准入成员）；`/cwd` 目标目录不存在时发 **DSH_Question 确认卡片**（✅ 创建 / ❌ 取消 / 自定义回答输入新路径，深度 ≤3 轮，60s 超时），不再直接报错 |
| 17 | **会话策略与群名联动**：`/cwd` 切换目录 = **切换会话**——session id 由 (群, 目录) 派生（`wildfire-{hash[:20]}-{dirHash[:16]}`），各目录会话独立持久化、上下文互不干扰；切回已访问目录时 **`resume` 恢复该目录上下文**，新目录则新建；`/reset` 仍是显式重置（清当前目录上下文）；部署前的旧会话按 cwd 匹配迁移（不匹配则新建）。群聊绑定成功后机器人 `modifyGroupInfo(type=0)` 把**群名改为目录最后一段**（`/a/b/c` → `c`），私聊不生效，改名失败不影响绑定流程 |
| 18 | **AI 面板静默通道（207 + type=3）**：AI 设置面板（模型/推理等级/沙箱/计划/工作目录/压缩/重置）的交互**不落消息流**——打开发 **DSH_Command(207)** 组合查询（透明消息，客户端不渲染），插件聚合面板数据（model 目录/effort/沙箱/计划/cwd/sessionId/根目录子目录）写 **scope=31 type=3**（键 `..._3`），面板读 type=3 渲染；更新操作发 207 `set`（cmd=命令文本），插件执行后写 **type=1 `lastChange`**（如 "模型 → xxx"，新回合开始时清除，**变更对群成员可见**）并刷新 type=3；`/` 命令菜单相应精简（面板覆盖的命令不再展示，插件命令保留为底层 API）。数据通道现为三路：type=1 状态 / type=2 统计 / type=3 面板数据 |

### 待定问题

1. **验证项（实现期）**：pending 卡片 × 进程重启——Agent turn 阻塞在 userQuestions ask 时，sweep dispose 或进程重启后 resume 的会话，DSH 是否会重新触发 ask？若会，需在 resume 后对超时卡片做过期标记，避免"卡片已过期但 Agent 仍在等答案"的僵尸态

> 原待定项：群 extra 写入权限——已决：**仅创建时由机器人写入**（决策 11），普通群不可手工标记。

## 8. 流程闭环审查（每项功能：入口 → 处理 → 反馈 → 异常兜底）

### 8.1 功能闭环核对表

| 功能 | 入口 | 处理 | 反馈 | 异常兜底 |
|------|------|------|------|---------|
| 创建 DSH 群 | 单聊 `/create-group`（§4.1.2） | 机器人 createGroup + 工作区选择（§4.1.3） | 回复群信息/工作区路径 | 建群失败→错误提示 |
| 工作区激活 | 创建者/成员首条消息 | 建目录+建会话（懒） | 状态条"运行中" | 目录创建失败→错误消息 |
| 群对话 | 群成员消息（@/触发词） | 插件→Agent→流式回复 | 流式 completed | turn 错误→错误消息 |
| 群管理命令 | 创建者发 /cwd /model /reset | 插件处理（仅创建者/owner） | 直接回复 | 无权限→提示 |
| 模型切换 | 私聊 /model（admin） | 运行时目录匹配→applyModel（保留推理等级） | 回复新模型 | 目录不可用→回退预设；未找到→/model 提示 |
| 沙箱切换 | 私聊/群 /sandbox（admin/创建者） | setSandboxMode 写会话日志 `sandbox/mode` 事件 | 回复新模式（下次工具调用生效） | sandbox 服务未加载→提示不可用；会话未激活→提示先发消息 |
| 单聊控制面板 | 私聊机器人 | 命令分发 / 全局助手会话 | 命令结果/回复 | 未知命令→/help |
| ask_user 提问 | Agent 触发 | DSH_Question 卡片 | 按钮应答→DSH_Answer | 超时→卡片 expired |
| 工具审批 | Agent 工具请求 | DSH_Approval 卡片 | 同意/拒绝→DSH_ApprovalResult | 超时→cancelled |
| plan 审阅 | 计划模式退出 | DSH_Question(intent=plan-review) | 批准/修改/拒绝 | 同上 |
| goal 管理 | 单聊 /goal 命令（§8.2 补） | ctx.goals 操作 | DSH_Goal 卡片 | 命令失败→提示 |
| 后台任务查询 | 单聊 /jobs 命令（§8.2 补） | ctx.jobs 查询 | 文本/卡片 | 无任务→提示 |
| 卡片期间文本 | 用户直接发文本 | 视为自定义回答（§2.2） | 回填 userQuestions | 卡片过期→按普通消息 |
| 进程重启 | - | 连接重连（SDK）；会话 resume | 状态恢复 | pending 卡片丢失→过期提示 |
| 群解散（108） | im-server 群通知 | 工作区销毁（§4.1.4） | 单聊通知（可选） | - |
| 工作区销毁 | 单聊 `/destroy-group`（owner/admin） | dismissGroup + 删目录 + 清状态（§4.1.4） | 单聊回执 | 删除失败→提示残留路径 |

### 8.2 审查发现并已补全的缺口

| # | 缺口 | 补全 |
|---|------|------|
| 1 | **创建 DSH 群无入口**（"群=工作区"无法产生） | §4.1.2 单聊 `/create-group`，机器人 createGroup（成员=用户+机器人） |
| 2 | **单聊普通文本行为未定义** | 定义全局助手会话（不落工作区）+ 提示语 |
| 3 | **DSH_Goal 无创建/管理入口** | 单聊 `/goal` 命令（create/view/pause/resume） |
| 4 | **jobs（后台任务）无入口** | 单聊 `/jobs` 命令 |
| 5 | **DSH_Question 仅支持单问题**，与 userQuestions 多问题能力不对齐 | 协议改为 `questions[]` 数组 |
| 6 | **卡片期间用户直接发文本**无定义 | 定义为 pending 卡片的自定义回答 |
| 7 | **拉机器人进群**是激活前提（否则消息不推送） | 向导强制步骤；文档明确 |
| 8 | **会话销毁/关闭逻辑缺失**（只有重置与回收） | §4.1.4 新增 `/destroy-group` + 群解散销毁流程；明确重置/回收/销毁三层语义 |
| 9 | **whiteList 与新授权模型关系**未说明 | 保留为 owner 级全局管理闸门（§4.1.1） |
| 12 | **`/allow` 命令与"审批白名单"易混淆** | 澄清：`/allow` 是**全局用户准入**（whiteList，owner 管理）；审批卡片（202）的"同意"是**单次工具放行**（allowed-once），二者无关 |
| 10 | **机器人被移除/换群主** | 按决策不处理（106/109 由 IM 群管理，插件不感知） |
| 11 | **工作区选择方案缺失**（用户如何在 IM 中选目录） | §4.1.3 三级方案（自动/catalog/路径） |
| 13 | **斜杠命令会被群触发策略丢弃**（如 `/cwd /path` 无@/问号/关键词）且会被 pending 卡片吞为文本应答 | 决策 14：`/` 开头一律按命令处理，跳过触发策略与卡片应答消费 |
| 14 | **功能开关关闭时命令被静默吞掉**（用户以为机器人没反应） | 决策 14：未启用命令与未知命令均给出明确提示 |
| 15 | **模型切换只能选预设，与 web UI 目录脱节** | 决策 12：`/model` 走 DSH 运行时目录（`ctx.llm`），预设降级为快捷方式 |
| 16 | **沙箱模式只能 profile 静态配置，改一次要重启** | 决策 13：`/sandbox` 按会话运行时切换（会话日志 `sandbox/mode` 事件，随 resume 持久化） |

### 8.3 已确认无需额外入口的能力（由 DSH 事件驱动，非 IM 操作）

- 进度/状态推送（scope=31）：Agent turn 事件自动推送，无需用户入口
- 流式回复、媒体收发：已有实现，双向闭环 ✓
- 审批/提问/plan 审阅：均由 Agent 内部触发，IM 仅提供应答入口 ✓

### 8.4 明确不做（防功能漂移）

- 群聊定向推送（im-server 定向消息能力）——群成员全员可交互，无需定向
- "我的工作区"侧边栏视图——单聊控制面板 + 群内状态足够（可二期加群列表徽标）
- 长按"加入协助"授权——已由"仅成员邀请 + 全员可交互"取代

---

## 9. 协议通用化 v2：Agent Interaction Protocol（不限于 DSH）

> 本章把 200-209 号段与 scope=31 通道从"DSH 专属方言"升级为**通用 Agent 交互协议**：
> 任何接入野火 IM 的 Agent（DSH / openclaw / botfather / 自研 …）都能复用同一套
> 卡片、状态、面板与遥控通道。**DSH 降级为第一个 provider**。
>
> 兼容原则：**全部走 `ver` 字段的加法演进，旧卡片/旧客户端/历史消息永远可读**；
> 载荷只增字段、不改既有字段语义；新客户端对 v1 与 v2 双分支渲染。
>
> 形态假设（默认，见待定问题 T2）：**单会话单 agent**——一个会话同时只有一个
> provider 在写状态/发卡。多 agent 并存的合并语义另议（§9.8）。

### 9.1 Agent 身份信封（所有通道共用）

```ts
interface AgentRef {
  provider: "dsh" | "openclaw" | /* 开放枚举 */ ;
  agentId: string;      // provider 内唯一
  label?: string;       // 展示名（默认 provider 名）
  model?: string;       // 当前模型（可选，展示用）
}
```

- **消息卡（200/202/206/208）**、**scope=31 type 1/2/3/4** 的 payload 顶层统一加 `agent?: AgentRef`
- **缺省（无 `agent` 字段）= 会话默认 agent**：老客户端、v1 载荷行为完全不变
- 类型常量语义改名（`DSH_Question` → 通用 `Agent_Question`），**线上只认数字 200**；
  `DSH_*` 保留为 `provider="dsh"` 的方言别名，SDK/代码命名迁移不做硬性要求（见 §9.7）
- **IM 层的 agent 标识 = 机器人用户 uid**（不区分 provider/agentId）：scope=31 的
  **写入 key 由 im-server 按请求身份追加机器人 uid**，详见 §9.2——机器人 API 本身不变

### 9.2 scope=31 槽位扩展（已按 key 级分区实现）

**key 格式（服务端已改，无兼容期）**：`${convType}-${convLine}-${convTarget}_${type}_${机器人uid}`
——每次写入由 im-server 依据请求机器人身份拼出完整 key，**多机器人各占一条 entry，
天然按 key 分区、无读改写冲突**（取代早期 payload `byAgent` 合并设想）。

| type | 语义（v2，通用） | 键 |
|------|-----------------|----|
| 1 | 运行状态：`RuntimeState` 字段已中立（state/phase/model/cwd/error…） | `..._1_<机器人uid>` |
| 2 | 计量：usage/turn/context/speed… | `..._2_<机器人uid>` |
| 3 | 面板数据（schema 化见下） | `..._3_<机器人uid>` |
| **4（新增）** | **agents 在场列表**：`{ agents: [{ ...AgentRef, robotUid, statusText?, lastActiveTs }] }` —— 会话内有哪些机器人 agent；**客户端据此把消息发送者 uid ↔ 状态 entry 后缀对应起来**（多机器人会话的唯一权威来源） | `..._4`（会话级，无 uid 后缀，由第一个在场 agent 维护） |
| 5-9 | 预留 | - |

- 客户端**不预知机器人 uid**：读取统一为「前缀 + 槽位」扫描 scope=31 设置表
  （`getUserSettings(31)` + `startsWith(\`<convType>-<line>-<target>_<type>_\`)`，后缀通配）——
  vue `dshState.js` / hm `dshState.ets` 已实现；单机器人会话命中唯一 entry
- 多机器人同会话：多条 entry 并存；**展示归属按消息 sender uid 匹配 entry 后缀**，
  无目录时取首个匹配（type=4 落地后改权威对应）
- 面板数据 schema：`{ sections: [{ title, items: [{ label, value, valueType? }] }] }`（渲染无关）

### 9.3 206 → AgentGoal（ver:2，目标卡通用化）

```json
{
  "ver": 2, "gid": "<flow-id>",
  "agent": { "provider": "dsh", "agentId": "…", "label": "DSH" },
  "title": "把聊天界面升级为 Agent 终端",      // 目标标题（原 objective）
  "state": "active" | "paused" | "blocked" | "complete" | "cancelled",
  "stage": "计划审批中",                       // 当前阶段自由文本
  "progress": 35,                             // 0-100（可选）
  "milestones": [ { "label": "协议定稿", "done": true },
                  { "label": "插件实现", "done": false } ],
  "updatedAt": 1787470162762
}
```

- **DSH → 通用映射**：`objective→title`；`phase→state`（同名字段，语义一致）；
  `roundsStarted` 不再暴露——映射为 `stage:"round N"` 或折叠进 milestones（由插件映射层翻译，
  客户端永远不需要知道"round"）
- **v1 兼容**：客户端 `ver` 缺失时按 v1 渲染（objective/phase/roundsStarted）
- `cancelled` 为 v2 新增终态（DSH goal 无取消态，其它 agent 可用）

### 9.4 207 → AgentCommand（遥控通道通用化）

- 载荷加 `agent?` 路由（缺省 = 会话默认 agent）
- **op 分两层**：
  - **公共集**（任何 agent 必须支持）：`query`（读状态/面板）、`set`（改参数）、
    `interrupt`（打断当前回合，新增）、`ping`（探活）
  - **专有集**：`cmd` 文本透传，由 provider 的适配器解析——`/model`、`/effort`、`/cwd`、
    `/sandbox`、`/plan`、`/compact`、`/reset` 是 **DSH 的词表**，客户端永不解析、不渲染（透明消息不变）
- 回执语义不变：`query`/`set` 结果写 type=3（sections schema）+ type=1 `lastChange`；
  `interrupt` 应答走普通消息或 type=1 状态
- 客户端无需改动（207 对客户端本就透明），只补公共 op 的幂等/超时约定文档

### 9.5 208 → AgentTask（ver:2，任务列表通用化）

```json
{
  "ver": 2, "flowId": "<run-instance>", "updatedAt": 1787470162762,
  "agent": { "provider": "dsh", "agentId": "…" },
  "tasks": [{
    "id": "t-1", "label": "编写协议文档",
    "kind": "subagent" | "job" | "step" | "tool" | "phase" | "…",  // 开放字符串
    "status": "running" | "done" | "failed" | "cancelled" | "waiting",
    "detail": "当前说明", "reason": "失败原因",
    "progress": 60, "updatedAt": 1787470162762
  }]
}
```

- **status 收敛为通用五态**；兼容别名（仅展示层）：v1 `completed`→done、`killed`→cancelled
- **kind 从协议概念降为开放字符串**：`subagent`/`job` 只是 DSH 的具体取值；客户端按
  未知 kind 通用渲染（图标 map + `⚪` 兜底，现状已天然兼容）
- 卡片更新方式不变：同 `flowId` 的消息由插件 `updateMessage` 原地更新

### 9.6 客户端渲染规范 v2

- **ver 探测**：`content.ver === 2` 走新字段，否则 v1 分支；两类都渲染，不做迁移刷新
- **206**：展示 title + stage/progress 进度条 + milestones 勾选；无 milestones 时仅 title/stage
- **208**：图标分类仅用于配色（agent/tool/subagent/job 已知色 + 默认灰），**渲染不依赖 kind 语义**
- **多 agent 展示**：收到 type=4 且 `agents.length > 1` 时，卡与状态条前缀 agent label；
  单 agent（缺省）时与现状完全一致，不加前缀

### 9.7 落地清单（实现顺序）

| 层 | 文件（代表） | 改动 |
|----|-------------|------|
| 协议定义 | `dsh-plugin.js/src/protocol.ts` | AgentRef/ver2 类型；AgentGoal/AgentTask v2 载荷；type=4 载荷 |
| 映射层 | `interactive.ts`/`agent.ts`/`inbound.ts`/`index.ts` | goal/subagent/job 事件 → v2 载荷翻译；type=3 sections schema；type=4 写入；op=interrupt |
| vue-pc-chat | `Dsh{Goal,TaskProgress,Question,Approval}ContentView.vue`、`dshState.js`、`DshAgentPanel.vue` | ver 双分支；status 别名；type=4/多 agent 前缀 |
| hm-chat | `custom_message/Dsh*.ets`、`dshState.ets` | 同上（ArkTS） |
| ios-chat | 待切 dsh 分支后 | 按同一协议实现，无需再设计 |

> 命名迁移（可选、不阻塞）：`DSH_QUESTION`→`AGENT_QUESTION` 等常量改名仅影响可读性，
> 建议随 provider 化一起做，避免未来第三份代码再复制 DSH 命名。

### 9.8 决策记录与待定

**新增已定决策（接 §7）：**

| # | 决策 |
|---|------|
| 19 | 200-209 段 + scope=31 = **通用 Agent 交互协议**；`AgentRef` 信封入所有载荷；DSH 为第一个 provider |
| 20 | scope=31 新增 **type=4 agents 在场列表**；type 1/2/3 键名与读取路径不变，载荷加 `agent` |
| 21 | 206/208 升级 **ver:2** 通用载荷（AgentGoal/AgentTask），DSH 事件经映射层翻译；v1 永久兼容 |
| 22 | 207 op 拆**公共集（query/set/interrupt/ping）**与 **provider 专有 cmd 词表** |

**新增待定问题（接 §7 待定）：**

- T2：**多 agent 同会话**——已按 **key 级分区**实现（机器人 uid 进 key，见 §9.2）：
  单会话多机器人各自写独立 entry、客户端前缀扫描。剩余歧义仅在**展示归属**
  （多 entry 时哪个对应哪个机器人）——由 type=4 agents 目录 + 消息 sender uid 对应解决，
  单机器人会话无歧义，不影响当前形态
- T3：会话身份抽象——`sessionId: wildfire-<hash>` 与群 `extra {"dsh":true}` 标记是 DSH 味，
  多 provider 接入时是否需要 provider 前缀的会话 key 与"agent 在场"激活语义（写 type=4 的时机/写者）
- T4：`ver` 兼容测试矩阵——老客户端收到 v2 卡、新客户端收到 v1 卡、历史消息重渲染，三态回归用例

### 9.9 实现状态（v2.2，五端通用 agent 化落地完成）

**已完成（协议层通用化，与 DSH 解耦）：**

| 层 | 内容 | 验证 |
|----|------|------|
| 插件 `protocol.ts` | 规范常量 **`AGENT_TYPE`**（200-209）+ `AgentRef` + 通用载荷类型（`AgentQuestion/Answer/Approval/Goal/Task/Command*`）；`ver:2` 的 goal/task 通用字段（title/state/stage/updatedAt/flowId 等）；`DSH_TYPE` 仅保留为兼容别名 | tsc ✓ |
| 插件发射点 | `sendGoal` 归一化（objective/phase/roundsStarted → title/state/stage + v1 兼容字段）；任务卡发 `ver:2` + flowId | tsc ✓ |
| vue-pc-chat | `MessageContentType.AGENT_*` 常量、`Agent*MessageContent` 类（真改名，0 残留） | node --check ✓ |
| hm-chat client | `MESSAGE_CONTENT_TYPE_AGENT_*`、`Agent*MessageContent/Data/Item` 类 | hvigor ✓ |
| hm-chat uikit | 卡片视图 struct → `Agent*ContentView`（文件名保留 Dsh*） | hvigor ✓ |
| android-chat | `ContentType_Agent_*` 常量、`Agent*MessageContent` 类（7 文件 git mv）、goal ver2（displayTitle/displayPhase/阶段行）、徽标 DSH→AI | `:client+:uikit` javac ✓ |
| ios-chat | `WFCCAgent*MessageContent`、`WFCUAgent*`（State/Cell/VC）符号改名（文件与 pbxproj 未动）、goal ver2（title/stage fallback）、徽标 DSH→AI | WFChatClient+WFChatUIKit 模拟器 BUILD ✓ |
| flutter-chat | `MESSAGE_CONTENT_TYPE_AGENT_*`、`Agent*MessageContent/CellBuilder/Panel/State` 改名、goal ver2（含 cancelled 灰态）、plugin key → `agent_settings` | imclient+chat analyze 0 errors（与基线一致）✓ |

**状态通道（scope=31）**：key v2（`..._<type>_<机器人uid>`）五端读取全部改为「前缀扫描」——
vue/hm（settings 全量取 + startsWith）、android（`ChatManager.getUserSettings(31)`）、
ios（`getUserSettings:scope` 本地库全量）、flutter（`Imclient.getUserSettings(31)`）；
事件驱动刷新不变、无轮询；插件写入零改动（服务端按请求身份补 uid）。

**goal 卡（206）**：五端均已容忍 ver:2（title/state/stage/updatedAt，stage 展示），v1 载荷渲染逐字节不变。

**遗留（有意保留，不影响协议）**：
- flutter-chat 流式消息**尚无 Markdown 渲染**（仅 linkify）——功能缺口，非本轮范围，建议后续按
  flutter_markdown 或富文本组件补齐（参考其它端表格/列表效果）
- 各端文件路径/资源名/视图持有者（`dsh*.ets/.js/.dart/.java/.m`、`Dsh*MessageContentViewHolder`、
  `WFCUDsh*.{h,m}` 文件名、`{"dsh":true}` 群标记、`WFCUDsh*Notification` 字符串）保留为
  内部命名——如需彻底去 DSH 可后续做纯文件级重命名（无协议影响）

---

**文档版本**：2.2（§9.9 五端实现状态：AGENT_* 与 scope31 key v2 已落地 插件/vue/hm/android/ios/flutter；flutter markdown 缺口与文件级命名列为遗留）
**状态**：插件与五端客户端已实现；待各端回归验证（goal/task v2 渲染、多机器人 entry、问答/审批链路）
