# 野火IM × DSH 对接完整性梳理报告

> 基于源码审计（dsh-plugin.js + 6 个客户端）与 DSH_INTEGRATION.md 文档交叉验证
> 审计日期：2026-08-22 ｜ 审计方式：只读代码（5 个并行子代理 + 人工核对）

---

## 1. 总体结论（回答两个核心问题）

### Q1：所有的 DSH 信息是不是都能显示在野火IM的会话中？

**结论：4/6 客户端可以（vue-pc-chat、android-chat、flutter-chat、ios-chat），2/6 不可以（uni-chat、qt-pc-chat）。**

| 信息类型 | vue-pc | android | flutter | ios | uni | qt |
|---------|:------:|:-------:|:-------:|:---:|:---:|:---:|
| 文本回复 (type 1) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 流式回复 (14/15/20) | ✅ | ✅ | ✅ | ✅ | ⚠️14/15 无20 | ❌ |
| 提问卡片 (200) | ✅ | ✅ | ✅ | ✅ | ❌未知消息 | ❌未知消息 |
| 回答摘要 (201) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 审批卡片 (202) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 审批结果 (203) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 目标卡片 (206) | ✅ | ✅ | ✅ | ✅无交互 | ❌ | ❌ |
| 会话状态 (scope=31) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 图片/文件/视频/语音 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Q2：所有的操作接口在野火IM中实现了？

**结论：同样 4/6 客户端实现；统一缺口是命令浮层缺 5 个命令。**

| 操作接口 | vue-pc | android | flutter | ios | uni | qt |
|---------|:------:|:-------:|:-------:|:---:|:---:|:---:|
| 提问回答（单选/多选/自定义/plan-review） | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 审批同意/拒绝 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 「/」命令浮层 | ✅13/10 | ✅13/10 | ✅ | ✅13/10 | ❌ | ❌ |
| 停止按钮（/stop） | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 命令集完整度 | ⚠️缺5 | ⚠️缺5 | ⚠️缺5 | ⚠️缺5+单聊/reset | ❌ | ❌ |

---

## 2. 插件侧能力全貌（dsh-plugin.js，已实现）

### 消息协议（200-209 预留段）
| 类型 | 用途 | 方向 |
|------|------|------|
| 200 DSH_QUESTION | 提问卡片（含选项/plan-review 意图） | 机器人→用户 |
| 201 DSH_ANSWER | 结构化回答 | 用户→机器人 |
| 202 DSH_APPROVAL | 工具审批卡片 | 机器人→用户 |
| 203 DSH_APPROVAL_RESULT | 审批结果 | 用户→机器人 |
| 206 DSH_GOAL | 目标进度卡片 | 机器人→用户 |
| 14/15/20 | 流式 generating/generated/cancelled | 机器人→用户 |
| scope=31 | 会话状态（idle/running/waiting_user/done + tool 进度） | 用户设置通道 |

### 操作命令（19 个）
`/help /cwd /ls /model /effort /reset /allow /disallow /allowlist /create-group /destroy-group /workspaces /goal /jobs /new /plan /compact /sandbox /stop`

### 交互面（interactive.ts）
- ask_user → DSH_Question 卡片（回答回传）
- 工具审批 → DSH_Approval 卡片（同意/拒绝回传）
- 状态推送 → scope=31（300ms 合并）
- goal 变化 → DSH_Goal 卡片

### 媒体
- 入站：图片（attachment 服务给模型）/语音（ASR）/视频/文件
- 出站：`[image:path]`/`[file:path]` 标记 → 上传 → 媒体消息

### 插件侧未实现（文档标注 P2/P3）
`/feedback`（消息反馈）、`/skills`、`/title`（会话标题）

---

## 3. 各客户端 DSH 支持详细清单

### ✅ vue-pc-chat（完整，11 项细节问题）
- 5 个消息类 + messageConfig 注册 + 4 个内容视图组件（Question/Approval/Goal/摘要）
- 流式 14/15/20（store 按 streamId 替换/删除，20 不渲染）
- scope=31 状态：标题徽标+状态文本+停止按钮、列表状态点、输入占位、/命令菜单（Tribute）
- 历史/发送均按 line=2；搜索 lines=[0,1,2]

### ✅ android-chat（完整实现，但主会话列表漏拉 line 2）
- 5 个消息类（client 模块）+ MyApp 注册 + 4 个 ViewHolder（含 plan-review 全屏页）
- 流式 14/15/20（streamId 匹配/钉底/取消删除）
- scope=31：副标题、输入占位、running 横幅+停止按钮、列表状态点（不可达，见下）
- ⚠️ **关键缺口：主会话列表 `ConversationListFragment.java:46` 仍用 lines=[0]** → DSH(line 2) 会话不进列表；列表 ViewHolder 也未注册 line=2（会显示"未知会话类型 0 2"）；未读角标不统计 line 2

### ✅ flutter-chat（完整，缺口集中在搜索/转发/入口）
- 5 个消息类 + 注册 + 四类 cell builder（PC+移动双形态，plan-review 全屏页）
- 流式 14/15/20（streamId 更新/钉底）
- scope=31：列表圆点+徽标、PC 标题徽标、手机副标题、输入占位、/命令浮层、停止按钮
- ⚠️ 缺口：PC 搜索窗口未注册 DSH 类型（显示未知消息）、全局搜索只搜 line [0]、群搜索打开 line 0、转发目标 line 0、无 DSH 会话新建入口

### ✅ ios-chat（完整，11 项细节问题）
- 5 个消息类（+load 自动注册）+ 4 个 cell（plan-review 全屏页）
- 流式 14/15/20（内存 1 分钟过期）
- scope=31：列表状态点+群徽标、标题副标题+停止按钮、输入占位、/命令浮层
- ⚠️ 缺口：206 无交互按钮、DSH 卡片不可复制/转发、分享扩展仅 line 0、伞头文件未导出

### ❌ uni-chat（无 DSH 支持）
- 200-206 无类型/无类/无注册 → 显示"未知消息"
- 流式 14/15 有通用支持（streamId 增量替换）；20 无
- scope=31、/命令、停止按钮、line==2 判定 全部无

### ❌ qt-pc-chat（无 DSH 支持，流式也没有）
- 200-206 无 → "当前版本不支持消息类型"
- **流式 14/15 也只有枚举无实现**（无解码类/无注册/无 cell → UnknownCell）
- scope=31、/命令、停止按钮 全部无

---

## 4. 共性缺失/问题清单（按优先级）

| # | 问题 | 影响端 | 优先级 |
|---|------|--------|:------:|
| 1 | **android 主会话列表不拉 line 2**（`ConversationListFragment.java:46`）→ DSH 会话不进列表 | android | 🔴 高 |
| 2 | **uni-chat / qt-pc-chat 完全无 DSH 支持**（卡片显示"未知消息"） | uni、qt | 🔴 高（如要支持） |
| 3 | **qt 流式消息 14/15 也不支持**（枚举有值无实现） | qt | 🔴 高 |
| 4 | **命令浮层缺 5 个命令**：/new /allow /disallow /allowlist /destroy-group（手动输入可用，仅无提示） | vue-pc/android/flutter/ios | 🟡 中 |
| 5 | **搜索/转发入口 line 参数不齐**：flutter 全局搜索只搜 line[0]、转发目标 line 0、群搜索打开 line 0；vue-pc 群搜索打开 line 0；ios 分享扩展仅 line 0 | flutter/vue-pc/ios | 🟡 中 |
| 6 | **DSH 卡片不计未读**（200-206 用 Persist 而非 Persist_And_Count）→ AI 会话无未读角标 | vue-pc/android/ios | 🟡 设计如此 |
| 7 | **无客户端 DSH 会话新建入口**（点机器人/新建会话都建 line 0） | android/flutter/ios | 🟢 低 |
| 8 | **type 19 冲突**：vue-pc 的 19=Poll_Result，插件若用 19 发输入态会被误渲染；须用 type 91 | vue-pc | 🟢 提示 |
| 9 | **卡片锁定本地态不持久**（重启后依赖机器人 updateMessage 更新 state） | 全部支持端 | 🟢 已知设计 |
| 10 | **插件侧未实现**：/feedback、/skills、/title | 插件 | 🟢 P2/P3 |
| 11 | 死代码/过时注释：vue-pc `isDshGroupExtra`、android `isDshGroupExtra` + ConversationFragment:813 注释 | vue-pc/android | 🟢 清理 |

---

## 5. 建议的修复优先级

1. **立即修复**：android `ConversationListFragment.java:46` lines `[0]` → `[0, 2]`（与 MainActivity 保持一致），并注册 line=2 的列表 ViewHolder —— 否则 Android 用户看不到任何 DSH 会话
2. **顺手补齐**：4 个支持端的命令浮层补 /new /allow /disallow /allowlist /destroy-group
3. **按需评估**：uni-chat / qt-pc-chat 的 DSH 支持（工作量较大，含消息类+卡片 UI+状态+命令；qt 还需补流式）
4. **细节优化**：flutter/vue-pc 群搜索打开 line 0 修正、ios 分享扩展加 line 2、单聊 AI 徽标（vue-pc/android 仅群聊有）

---

## 6. 结论

DSH 对接的**主力客户端（vue-pc、android、flutter、ios）已实现约 95% 的协议与交互**，信息展示与操作接口基本齐全；**主要缺口**是：
- 🔴 android 主会话列表漏拉 line 2（一个参数即可修复）
- 🔴 uni/qt 完全未对接（如需支持需完整实现）
- 🟡 命令浮层 5 个命令提示、搜索/转发 line 参数

插件侧（dsh-plugin.js）功能完整，仅 3 个低优先级功能未实现（feedback/skills/title）。
