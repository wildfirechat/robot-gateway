/**
 * DSH × Wildfire IM structured interaction protocol.
 *
 * Message types occupy the official Wildfire reserved segment 200-209
 * (see INTERACTION_DESIGN.md §2.1). Payload convention:
 *   payload.type              = DSH_* type number
 *   payload.content           = JSON string (structured data)
 *   payload.searchableContent = human summary (search/notification visible)
 *   payload.persistFlag       = set by the sender (cards persist)
 */

/** Wildfire IM message type numbers for DSH interactions. */
export const DSH_TYPE = {
  QUESTION: 200, // 机器人→用户 提问卡片（含选项）
  ANSWER: 201, // 用户→机器人 结构化回答
  APPROVAL: 202, // 机器人→用户 工具审批卡片
  APPROVAL_RESULT: 203, // 用户→机器人 审批结果
  // 204/205 已废弃：进度与状态改走 scope=31 会话用户设置推送（见 interactive.ts）
  GOAL: 206, // 机器人→用户 目标进度卡片
  COMMAND: 207, // 用户→机器人 AI 面板指令（透明消息，客户端不渲染）
  TASK_PROGRESS: 208, // 机器人→用户 任务进度卡片（子任务 + 后台任务，updateMessage 原地更新）
  // 209 保留
} as const;

export type DSHType = (typeof DSH_TYPE)[keyof typeof DSH_TYPE];

/**
 * 任务进度卡片（208 DSH_TaskProgress）：会话内展示子任务/后台任务进度。
 * 一张卡片一个会话（首次 sendCard，之后 updateMessage 原地更新）。
 * - subagent 项：来自 scoped 事件 subagent/start、subagent/end（含嵌套子代理，
 *   见 interactive.ts bindTaskScope）。
 * - job 项：turn/end 时从 jobs 服务同步（jobs.list(agent)，见 syncJobs）。
 * 状态与鸿蒙客户端（hm-chat DshTaskProgressContentView）对齐：
 * running / done / failed / completed / killed。
 */
export interface DSHTaskItem {
  /** 任务种类：subagent=子代理任务；job=后台任务。 */
  kind: "subagent" | "job";
  /** 任务/子会话 id。 */
  id: string;
  /** 任务标签（子代理 label / 后台任务 label，尽力而为；缺失时客户端显示 id 前缀）。 */
  label?: string;
  /** 状态：running / done / failed / completed / killed。 */
  status: "running" | "done" | "failed" | "completed" | "killed";
  /** 失败原因（status=failed 时）。 */
  reason?: string;
  /** 结束摘要（子任务最终输出截断，客户端暂不渲染、预留）。 */
  result?: string;
  /** 最近更新时间（Unix ms）。 */
  updatedAt: number;
}

export interface DSHTaskProgressPayload {
  tasks: DSHTaskItem[];
  updatedAt: number;
}

/** 任务卡片摘要（searchableContent/通知可见）。 */
export function summarizeTasks(data: DSHTaskProgressPayload): string {
  const running = data.tasks.filter((t) => t.status === "running").length;
  const total = data.tasks.length;
  if (total === 0) return "🧩 任务：无";
  return running > 0 ? `🧩 任务 ${total}（${running} 运行中）` : `🧩 任务 ${total}（${data.tasks.every((t) => t.status === "failed") ? "全部失败" : "全部完成"}）`;
}

/**
 * DSH_Command (207)：AI 面板与机器人的静默指令通道（不显示在消息流）。
 * - op=query  → 组合查询：插件聚合面板数据（模型目录/effort/沙箱/计划/cwd/目录列表）
 *               写入 scope=31 type=3（面板数据），不回复消息
 * - op=set    → 更新：cmd 为命令文本（如 "/model deepseek-official/xxx"），
 *               插件执行后把变更写入 type=1 状态（lastChange，变更可见）并刷新 type=3
 */
export interface DSHCommandPayload {
  op: "query" | "set";
  /** op=set 时的命令文本（/model /effort /cwd /sandbox /plan /compact /reset）。 */
  cmd?: string;
  /** 客户端请求序号（幂等/去重）。 */
  seq?: number;
}

export interface DSHQuestionOption {
  label: string;
  description?: string;
}

export interface DSHQuestionItem {
  id: string;
  header?: string;
  question: string;
  detail?: string;
  options?: DSHQuestionOption[];
  multiSelect?: boolean;
  /** DSH intent is an object: { kind: 'plan-review', approve: <option label> }. */
  intent?: { kind: string; approve?: string };
}

export interface DSHQuestionPayload {
  qid: string;
  questions: DSHQuestionItem[];
}

export interface DSHAnswerPayload {
  qid: string;
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

export interface DSHApprovalPayload {
  aid: string;
  toolName: string;
  reason?: string;
}

export interface DSHApprovalResultPayload {
  aid: string;
  action: "approve" | "reject";
}

export interface DSHGoalPayload {
  gid: string;
  objective: string;
  phase: string; // active | paused | blocked | complete
  roundsStarted: number;
}

/** Build a message payload object (shape consumed by the Wildfire SDK sendMessage). */
export function buildPayload(
  type: number,
  data: unknown,
  summary: string,
  persistFlag: number
): any {
  return {
    type,
    content: JSON.stringify(data),
    searchableContent: summary,
    persistFlag,
  };
}

/** Parse payload.content JSON; returns null on failure. */
export function parseContent<T>(payload: any): T | null {
  try {
    const raw = typeof payload?.content === "string" ? payload.content : null;
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Human summary for a question card (searchable/notification text). */
export function summarizeQuestion(data: DSHQuestionPayload): string {
  const first = data.questions[0];
  return first ? `🤔 ${first.header ? `【${first.header}】` : ""}${first.question}` : "🤔 需要你确认";
}

/** Human summary for an approval card. */
export function summarizeApproval(data: DSHApprovalPayload): string {
  return `🔐 工具审批：${data.toolName}${data.reason ? `（${data.reason}）` : ""}`;
}

/** Human summary for a goal card. */
export function summarizeGoal(data: DSHGoalPayload): string {
  return `🎯 ${data.objective || "目标"}（${data.phase ?? ""}，round ${data.roundsStarted ?? 0}）`;
}
