# DeepSeek Harness 野火IM 插件

将野火IM 作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的一个消息渠道：用户通过野火IM 客户端与机器人对话，消息进入 DSH Agent 执行，Agent 回复（含流式输出）实时回传。

> 本插件依赖 [robot-gateway](https://github.com/wildfirechat/robot-gateway)，请先部署 robot-gateway，并在野火IM 中创建机器人（可参考 BotFather 功能自动创建）。

设计文档：[DSH_INTEGRATION.md](../DSH_INTEGRATION.md)

## 架构

```
野火客户端 ──► 野火IM ──► robot-gateway(:8884 WebSocket)
                                  │
                                  ▼
        dsh 进程（--profile web）内：本插件（Cordis plugin）
              │                              │
              │ RobotServiceClient           │ ctx.agents + session/event
              ▼                              ▼
        野火网关 SDK               DSH Agent（模型 + 工具 + goal）
```

## 安装

> **SDK 版本说明**：状态/进度推送依赖 `RobotServiceClient.updateConversationUserSetting`，该方法尚未发布到 npm。当前 `package.json` 以 `file:../client.js` 引用本仓库的本地 SDK 源码；待 SDK 新版本（≥1.0.6）发布后改回版本号依赖。`npm pack` 打包前需先发布 SDK，否则 file: 依赖在安装侧无法解析。

```bash
# 1. 构建并打包
cd dsh-plugin.js
npm install
npm run build
npm pack

# 2. 安装到 dsh web profile
dsh plugin --profile web add ./wildfirechat-dsh-wildfire-0.1.0.tgz

# 3. 激活并配置：编辑 ~/.dsh/profiles/web/cordis.patch.yml，追加：
# - insert:
#     - id: wildfire
#       name: '@wildfirechat/dsh-wildfire'
#       config:
#         gatewayUrl: ws://your_gateway_host:8884/robot/gateway
#         robotId: your_robot_id
#         robotSecret: your_robot_secret

# 4. 启动
dsh web
```

## 部署形态（web GUI 与 IM 不是二选一）

### 常见问题：`dsh` 命令找不到 / 如何后台运行

`npx @deepseek-ai/dsh web` 只是临时执行，**不会安装 `dsh` 命令**（所以 `dsh --version` 报 command not found）。建议全局安装：

```bash
npm install -g @deepseek-ai/dsh
dsh --version   # 确认可用（nvm 用户 bin 在 ~/.nvm/versions/node/<ver>/bin）
```

后台运行（机器人需 7×24 在线）：

```bash
# 简单方案
nohup dsh web > ~/.dsh/dsh-web.log 2>&1 &
tail -f ~/.dsh/dsh-web.log      # 查看启动日志
pkill -f "dsh web"              # 停止

# 不全局安装时的等价写法（--yes 跳过 npx 交互确认）
nohup npx --yes @deepseek-ai/dsh web > ~/.dsh/dsh-web.log 2>&1 &
```

macOS 建议用 launchd 开机自启（模板见 [DSH_INTEGRATION.md 部署章节](../DSH_INTEGRATION.md)），Linux 用 systemd。

- **并存模式**（`dsh web` profile + 本插件）：浏览器 GUI 与 IM 同时可用，**会话互通**（GUI 可查看/代答 IM 会话）。但 ask_user 提问、plan 审阅、工具审批归**浏览器**（无浏览器时挂起）；模型/工具/goal/流式回复两面共享
- **IM 专用模式**（自定义 profile，无 GUI）：提问/审批/plan 审阅**全部走 IM**，无人值守可用

### 切换到 IM 专用模式（3 步）

```bash
# 1. 创建 wildfire profile 并安装插件（自动初始化，bundles 默认 [dsh-base]）
dsh plugin --profile wildfire add ./wildfirechat-dsh-wildfire-0.1.0.tgz

# 2. 迁移配置：把 web profile 的插件配置复制过来
cp ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/wildfire/cordis.patch.yml

# 3. 停掉 web profile 进程，启动 IM 专用 profile
dsh --profile wildfire
```

**重要**：`dsh-tool-ask-user` 不在任何 bundle 内，必须在 `~/.dsh/profiles/wildfire/cordis.patch.yml` 中显式启用，否则 Agent 没有 `ask_user` 工具（提问会退化为模型直接发文本）：

```yaml
- insert:
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
    - id: wildfire
      name: '@wildfirechat/dsh-wildfire'
      config:
        gatewayUrl: ws://...
        robotId: ...
        robotSecret: ...
```

验证：日志出现 `userQuestions provider registered (ask_user via IM)` 与 `approval answerer registered`；Agent 的提问与审批消息出现在 IM 会话中。回切并存：停 wildfire profile，改跑 `dsh web`。

详见 [DSH_INTEGRATION.md 部署模式](../DSH_INTEGRATION.md)。

## 配置

| 配置项 | 必填 | 说明 |
|--------|------|------|
| `gatewayUrl` | 是 | 野火机器人网关 WebSocket 地址 |
| `robotId` | 是 | 机器人 ID |
| `robotSecret` | 是 | 机器人密钥 |
| `asrServer` | 否 | 语音转文字服务地址，配置后语音消息先转文字再进入 Agent |
| `requireMention` | 否 | 群聊触发模式：默认 `false` = 群内所有消息触发（无需@）；`true` = 需@或问号/关键词触发 |
| `helpKeywords` | 否 | 群聊触发关键词（逗号分隔），默认 `帮,请,分析,总结` |
| `whiteList.enabled` | 否 | 是否启用白名单，默认 `false` |
| `whiteList.allowedUsers` | 否 | 允许的用户 ID 列表 |
| `whiteList.allowedGroups` | 否 | 允许的群组 ID 列表 |
| `whiteList.deniedMessage` | 否 | 未授权时的回复文案 |
| `whiteList.includeOwner` | 否 | 机器人 owner 自动放行（经 `getProfile()` 获取），默认 `true` |
| `whiteList.persistFile` | 否 | 动态 `/allow` 名单持久化文件，默认 `~/.dsh/wildfire-allowlist.json` |
| `session.idleTimeoutMs` | 否 | 会话空闲回收时间，默认 24h |
| `session.maxSessions` | 否 | 最大并发 Agent 会话数，默认 200 |
| `streaming.throttleMs` | 否 | 流式推送节流（毫秒），默认 300 |
| `streaming.initialPlaceholder` | 否 | 占位消息文本，默认 `…` |
| `workspace.mode` | 否 | 工作目录模式：`global`（默认）/ `per-session` / `mapped` |
| `workspace.path` | 否 | 全局工作目录，默认 `process.cwd()`（DSH 进程启动目录） |
| `workspace.sessionDir` | 否 | `per-session` 模式的父目录，每个会话独立子目录 |
| `workspace.map` | 否 | `mapped` 模式：会话键（或裸用户/群 ID）→ 目录映射 |
| `workspace.allowedRoots` | 否 | 安全围栏：所有工作目录必须位于这些根目录内 |
| `workspace.root` | 否 | **项目根目录**：所有项目都在此目录下。`/cwd` 的相对路径按此解析、`/create-group auto` 自动目录也在此之下、`/ls` 默认列此目录。未配置时回退：`autoRoot` → 第一个 `allowedRoot` → `path` |
| `workspace.allowCwdCommand` | 否 | 允许 `/cwd`、`/ls` 命令（私聊+群聊，按权限），默认 `false` |
| `workspace.persist` | 否 | 持久化 `/cwd` 绑定到磁盘，默认 `true` |
| `workspace.persistFile` | 否 | 持久化文件，默认 `~/.dsh/wildfire-workspaces.json` |
| `access.adminUsers` | 否 | 管理员用户 ID 列表（门控管理命令） |
| `access.adminGroups` | 否 | 管理员群组 ID 列表 |
| `access.groupOwnerCanManage` | 否 | 群主可在本群执行 `/cwd`（需机器人入群），默认 `true` |
| `model.default` | 否 | 默认模型预设 ID；省略则用 DSH 当前选择 |
| `model.allowed` | 否 | 可选：模型预设快捷方式 `{ id: { provider, model, reasoningEffort? } }`（主路径为 `/model` 的运行时目录，预设仅作快捷方式） |
| `model.map` | 否 | 按会话键（或裸用户/群 ID）固定模型预设 |
| `model.allowModelCommand` | 否 | 允许私聊 `/model`、`/effort` 命令，默认 `false` |
| `media.downloadDir` | 否 | 入站媒体临时目录，默认 `/tmp/wildfire-media` |
| `media.outboundEnabled` | 否 | 解析回复中的 `[image:path]`/`[media:path]` 标记并发送媒体，默认 `true` |
| `interaction.askUserEnabled` | 否 | 注册 userQuestions provider（Agent 提问→IM 回答），默认 `true` |
| `interaction.approvalEnabled` | 否 | 注册审批 answerer（工具审批→IM 同意/拒绝），默认 `true` |
| `interaction.askUserTimeoutMs` | 否 | 提问等待超时，默认 300000 |
| `interaction.approvalTimeoutMs` | 否 | 审批等待超时，默认 120000 |
| `interaction.approvedLabel` | 否 | 放行关键词，默认 `同意` |
| `interaction.deniedLabel` | 否 | 拒绝关键词，默认 `拒绝` |
| `security.maxMessagesPerMinute` | 否 | 每会话每分钟消息数上限（0=不限，默认 0） |

完整示例：

```yaml
- insert:
    - id: wildfire
      name: '@wildfirechat/dsh-wildfire'
      config:
        gatewayUrl: ws://127.0.0.1:8884/robot/gateway
        robotId: your_robot_id
        robotSecret: your_robot_secret
        asrServer: http://127.0.0.1:9000/asr
        requireMention: true
        helpKeywords: "帮,请,分析,总结"
        whiteList:
          enabled: false
          allowedUsers: ["user001"]
          allowedGroups: ["group001"]
          deniedMessage: "未授权，不允许使用"
        session:
          idleTimeoutMs: 86400000
          maxSessions: 200
        streaming:
          throttleMs: 300
          initialPlaceholder: "…"
        workspace:
          mode: global                    # global | per-session | mapped
          path: /data/projects/default    # 全局目录（默认 process.cwd()）
          sessionDir: /data/wildfire-workspaces
          map:
            "wildfire:user:user001": /data/projects/repo-a
          allowedRoots: ["/data/projects"]
          allowCwdCommand: true
        access:
          adminUsers: ["user001"]         # 管理员用户（门控管理命令）
          adminGroups: ["grp-admin"]      # 管理员群组
        model:
          default: fast
          allowed:
            fast: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" }
            deep: { provider: "deepseek", model: "deepseek-reasoner" }
          map:
            "wildfire:user:user001": deep
          allowModelCommand: true
```

## 工作目录（Workspace）与多群

Agent 的工作目录在 DSH 会话创建时写入会话头（`meta.cwd`），之后不可变。插件按以下优先级解析：

```
/cwd 绑定（持久化）  >  mapped 映射  >  per-session 目录  >  global path  >  process.cwd()
```

- **global**：所有会话共享 `workspace.path`
- **per-session**：每个会话独立目录 `workspace.sessionDir/<sessionId>`（自动创建）
- **mapped**：按会话键（`wildfire:user:x` / `wildfire:group:x` 或裸 ID）映射到具体项目目录

### 多群场景（推荐）

每个群对应一个独立工作目录，动态绑定、重启不丢：

```
1. 野火IM 建群（如"项目A群"），把机器人拉进群
2. 群主在群里发:  /cwd /data/projects/project-a
3. 群成员 @机器人 提问 → 会话在 project-a 开启
4. 另建群同样绑定 /cwd /data/projects/project-b，互不干扰
```

`allowCwdCommand: true` 时命令（`/cwd`、`/ls` 私聊+群聊）：

| 命令 | 权限 | 行为 |
|------|------|------|
| `/cwd` | 任一准入成员 | 查询当前工作目录 + 项目根目录 |
| `/cwd <路径>` | 私聊：管理员；群聊：群主或管理员群成员 | 绑定目录（持久化），会话重置；**相对路径按项目根目录（`workspace.root`）解析**；目录不存在时发确认卡片（✅ 创建 / ❌ 取消，或自定义回答直接输入新路径） |
| `/cwd clear` | 同上 | 清除绑定，恢复默认 |
| `/ls [子目录]` | 任一准入成员 | 列出项目根目录（或子目录）内容；相对路径按根目录解析 |

群聊修改需**群主**（`access.groupOwnerCanManage`，默认开，通过 `getGroupInfo` 校验，机器人须在群里）或**管理员群组**成员。

## 访问权限

- **准入**（谁能触发机器人）：`whiteList`——启用时**机器人 owner 自动放行**（`includeOwner`，默认开）、静态 `allowedUsers`/`allowedGroups`、动态 `/allow` 名单任一命中即放行；未启用时全员可用
- **管理**（谁能执行命令）：`access.adminUsers` / `adminGroups`；未配置管理员时，任一准入用户可执行

白名单动态命令（私聊=管理员，群聊=群主/管理员）：

| 命令 | 行为 |
|------|------|
| `/allow <userId>` | 加入白名单（持久化） |
| `/disallow <userId>` | 移出白名单 |
| `/allowlist` | 查看白名单状态 |
| `/create-group [工作区]` | 创建 DSH 工作区群（仅私聊，owner/admin；工作区三级选择：auto/目录目录/路径） |
| `/destroy-group <groupId>` | 销毁工作区群（解散群+删目录+清注册表，仅私聊，owner/admin） |
| `/new <groupId>` | 重置指定群的会话（上下文清空，工作区保留；仅私聊，owner/admin） |
| `/workspaces` | 列出所有 DSH 工作区群（仅私聊） |
| `/jobs` | 汇总所有存活会话的后台任务（仅私聊，owner/admin） |
| `/goal <groupId> [目标]` | 查看/创建群目标（DSH_Goal 卡片） |
| `/goal <groupId> pause` / `resume` | 暂停/恢复群目标（goal 循环暂停≠停止当前任务，停止用 `/stop`） |
| `/plan [on\|off]` | 查看/开关当前会话的计划模式（私聊 admin / 群内创建者或管理员；退出计划时 plan-review 走提问卡片） |
| `/compact` | 手动压缩当前会话上下文（权限同上；回复折叠的节点/token 数） |
| `/sandbox [模式]` | 查看/切换当前会话的沙箱权限模式（read-only 只读 / workspace-write 仅写工作区 / danger-full-access 完全放开；下一次工具调用生效，随会话持久化；权限同上） |

通用命令（私聊+群聊，准入成员可用）：

| 命令 | 行为 |
|------|------|
| `/stop` | 停止当前会话正在运行的任务（中断当前 turn，pending 卡片过期） |
| `/help` | 查看可用命令（按权限过滤）；未识别的 `/xxx` 命令会提示 `/help` |

管理命令均**按权限**执行；`/model`、`/effort`、`/reset` 仅私聊。

## 大模型与推理等级

模型选择按以下优先级解析（会话级覆盖，**下一条消息生效、上下文保留**）：

```
/model、/effort 运行时覆盖  >  model.map  >  model.default 预设  >  DSH 当前选择
```

模型与推理等级**分开设置**：`/model` 只切模型（保留当前推理等级），`/effort` 只调推理等级。可选模型来自 **DSH 运行时目录**（`ctx.llm.listProviders()` + `listModels()`，与 web UI 模型选择器同源），`model.allowed` 预设仅作可选快捷方式，`model.default` 与 `model.map` 设定默认与按会话固定。

`allowModelCommand: true` 时，私聊命令：

| 命令 | 行为 |
|------|------|
| `/model` | 查看当前模型 + 运行时模型目录（按 provider 分组），附预设快捷列表 |
| `/model deepseek/deepseek-chat` | 切换到目录中的模型（保留当前推理等级） |
| `/model fast` | 目录匹配不到时按预设 `fast` 切换（向后兼容） |
| `/effort` | 查看当前推理等级 |
| `/effort high` | 在当前模型上设置推理等级 |
| `/reset` | 清空会话上下文 |

## 使用

- **私聊**：直接发送消息，AI 立即回复（流式打字效果）
- **群聊**：@机器人、或以问号结尾、或包含关键词时触发
- **斜杠命令优先**：任何 `/` 开头的消息视为命令，**跳过群触发策略**（无需@/问号/关键词）且不消费为 pending 卡片的文本应答；`/stop` 可随时中断运行中的 turn；功能开关未启用的命令（`/cwd`、`/model`、`/effort`）与未知 `/xxx` 均给出明确提示
- 每个用户/群组独立会话，多轮对话上下文连续

## 特性

- **双向桥接**：野火IM ↔ DSH Agent
- **流式回复**：`assistant/chunk` → 野火流式消息（generating → completed）
- **会话隔离**：私聊/群聊各自独立 DSH 会话
- **群聊过滤**：@提及、问号、关键词触发
- **白名单**：用户/群组两级控制
- **媒体收发**：图片（模型可看图）、文件、语音（ASR 转文字）；Agent 产出文件经 `[image:path]` 标记回传
- **ask_user 提问**：Agent 提问 → DSH_Question 卡片（选项按钮/自定义输入，支持 plan 审阅样式）→ 用户应答即答案
- **工具审批**：Agent 工具请求 → DSH_Approval 卡片 → 用户同意/拒绝放行或拦截
- **状态可见**：Agent 生命周期（运行中/思考/工具/等待输入/空闲）经 scope=31 会话级用户设置实时推送，客户端渲染状态徽标
- **任务控制**：`/stop` 中断当前任务；`/goal` 长任务创建/暂停/恢复；`/jobs` 后台任务汇总
- **多群工作区**：每群独立工作目录，`/cwd` 动态绑定并持久化
- **模型/推理等级**：`/model`、`/effort` 会话级切换
- **长任务**：DSH goal 机制承载长时任务

## 目录结构

```
src/
├── index.ts      # 插件入口与生命周期
├── config.ts     # 配置类型与校验
├── clients.ts    # 野火机器人客户端管理
├── agent.ts      # DSH Agent 会话管理（cwd/模型注入、session/event 桥接）
├── inbound.ts    # 入站消息处理、管理命令、流式回复
├── access.ts     # 访问权限（管理员门控管理命令）
├── model.ts      # 模型/推理等级选择
├── workspace.ts  # 工作目录解析（含持久化）
├── interactive.ts# 交互缝隙：ask_user 提问 + 工具审批（经 IM）
├── media.ts      # 媒体收发（附件/下载/上传）
├── whitelist.ts  # 白名单过滤
└── utils.ts      # 群聊过滤、mention 检测、payload 解析
```

## 安全

安全设计详见 [DSH_INTEGRATION.md 安全章节](../DSH_INTEGRATION.md)。要点：

- **DSH 沙箱是文件安全的唯一硬围栏**：请在 profile patch 中配置 `sandbox-policy`（`workspace-write` 或 `read-only`，默认 `read-only`），不要使用 `danger-full-access`
- 出站媒体仅允许会话工作目录 + `workspace.allowedRoots` 内的文件（realpath 校验，防 `[image:/etc/passwd]` 外传）
- 审批/提问回复仅 **turn 发起者**可答（旁观者不能替放行）
- 公开机器人建议：`whiteList` + `security.maxMessagesPerMinute` + `access.adminUsers`

## 调试

```bash
# DSH 日志（插件日志前缀 [wildfire]）
dsh web 2>&1 | grep wildfire
```

## License

MIT
