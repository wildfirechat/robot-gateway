/**
 * Agent × Wildfire IM structured interaction protocol (agent-agnostic).
 *
 * The 200-209 segment is the official Wildfire AI-interaction reservation
 * (INTERACTION_DESIGN.md §2.1); the protocol is NOT DSH-specific — any agent
 * provider (DSH / openclaw / …) may use the same cards, states and channels.
 *
 * Payload convention:
 *   payload.type              = AGENT_* type number
 *   payload.content           = JSON string (structured data)
 *   payload.searchableContent = human summary (search/notification visible)
 *   payload.persistFlag       = set by the sender (cards persist)
 *
 * scope=31 conversation user settings carry runtime state/metrics/panel:
 * key = `<convType>-<line>-<target>_<type>_<机器人uid>` (server appends the
 * writing robot's uid), payload JSON is provider-agnostic.
 */

/**
 * Wildfire IM message type numbers for agent interactions.
 * (Formerly exported as DSH_TYPE; AGENT_* is the canonical name.)
 */
export const AGENT_TYPE = {
  QUESTION: 200, // 机器人→用户 提问卡片（含选项）
  ANSWER: 201, // 用户→机器人 结构化回答
  APPROVAL: 202, // 机器人→用户 工具审批卡片
  APPROVAL_RESULT: 203, // 用户→机器人 审批结果
  // 204/205 已废弃：进度与状态改走 scope=31 会话用户设置推送（见 interactive.ts）
  GOAL: 206, // 机器人→用户 目标进度卡片（ver:2 通用载荷，见 AgentGoalPayload）
  COMMAND: 207, // 用户→机器人 AI 面板指令（透明消息，客户端不渲染）
  TASK_PROGRESS: 208, // 机器人→用户 任务进度卡片（ver:2 通用载荷，updateMessage 原地更新）
  // 209 保留
} as const;

export type AgentType = (typeof AGENT_TYPE)[keyof typeof AGENT_TYPE];

/** 兼容别名（内部旧引用；wire 类型号不变）。 */
export const DSH_TYPE = AGENT_TYPE;
export type DSHType = AgentType;

/** 发出本载荷的 agent 身份（多 agent 会话中用于归属展示；缺省 = 会话默认 agent）。 */
export interface AgentRef {
  provider: string; // dsh | openclaw | …（开放枚举）
  agentId: string; // provider 内唯一
  label?: string; // 展示名
  model?: string; // 当前模型（可选）
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionItem {
  id: string;
  header?: string;
  question: string;
  detail?: string;
  options?: AgentQuestionOption[];
  multiSelect?: boolean;
  /** 可选增强（如 DSH plan-review 审阅样式）；通用客户端忽略即可。 */
  intent?: { kind: string; approve?: string };
}

export interface AgentQuestionPayload {
  qid: string;
  questions: AgentQuestionItem[];
}

export interface AgentAnswerPayload {
  qid: string;
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

export interface AgentApprovalPayload {
  aid: string;
  toolName: string;
  reason?: string;
}

export interface AgentApprovalResultPayload {
  aid: string;
  action: "approve" | "reject";
}

/** 通用目标/长任务状态（ver:2；v1 兼容字段 objective/phase/roundsStarted 仅供旧客户端回退）。 */
export type AgentGoalState = "active" | "paused" | "blocked" | "complete" | "cancelled";

export interface AgentGoalMilestone {
  label: string;
  done: boolean;
}

export interface AgentGoalPayload {
  ver?: 2;
  gid: string;
  /** 目标标题（v2 主字段；旧客户端回退到 objective）。 */
  title?: string;
  /** 当前阶段名（自由文本，如 "计划审批中" / "round 3"）。 */
  stage?: string;
  state: AgentGoalState;
  /** 0-100。 */
  progress?: number;
  milestones?: AgentGoalMilestone[];
  updatedAt: number;
  agent?: AgentRef;
  // ---- v1 兼容字段（DSH provider 发射时保留，旧客户端继续渲染） ----
  objective?: string;
  phase?: string;
  roundsStarted?: number;
}

/** Agent 任务项（ver:2 开放 kind；status 通用五态 + 兼容别名 completed/killed）。 */
export interface AgentTaskItem {
  /** 任务种类（开放字符串：subagent / job / step / tool / phase …）。 */
  kind: string;
  id: string;
  label?: string;
  /** running / done / failed / completed(兼容=done) / killed(兼容=cancelled) / waiting。 */
  status: "running" | "done" | "failed" | "completed" | "killed" | "waiting";
  reason?: string;
  result?: string;
  detail?: string;
  /** 0-100。 */
  progress?: number;
  updatedAt: number;
}

export interface AgentTaskProgressPayload {
  ver?: 2;
  /** 本次任务流实例（同一 flowId 由 updateMessage 原地更新）。 */
  flowId?: string;
  tasks: AgentTaskItem[];
  updatedAt: number;
  agent?: AgentRef;
}

/**
 * Agent_Command (207)：用户→agent 的静默指令通道（客户端不渲染）。
 * - op=query  → 组合查询：agent 聚合面板数据写入 scope=31 type=3，不回复消息
 * - op=set    → 更新：cmd 为 provider 词表命令（如 DSH 的 "/model xxx"），
 *               执行后写 type=1 状态 lastChange 并刷新 type=3
 * 公共 op（interrupt/ping）为协议扩展点，由各 provider 按需实现。
 */
export interface AgentCommandPayload {
  op: "query" | "set" | "interrupt" | "ping";
  /** op=set 时的 provider 词表命令。 */
  cmd?: string;
  /** 客户端请求序号（幂等/去重）。 */
  seq?: number;
  /** 目标 agent（缺省 = 会话默认 agent）。 */
  agent?: AgentRef;
  /** 目标机器人（多机器人会话寻址；缺省 = 本消息会话对应的机器人）。 */
  robotId?: string;
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
export function summarizeQuestion(data: AgentQuestionPayload): string {
  const first = data.questions[0];
  return first ? `🤔 ${first.header ? `【${first.header}】` : ""}${first.question}` : "🤔 需要你确认";
}

/** Human summary for an approval card. */
export function summarizeApproval(data: AgentApprovalPayload): string {
  return `🔐 工具审批：${data.toolName}${data.reason ? `（${data.reason}）` : ""}`;
}

/** Human summary for a goal card (ver:2 title / v1 objective). */
export function summarizeGoal(data: AgentGoalPayload): string {
  const title = data.title || data.objective || "目标";
  return `🎯 ${title}（${data.state ?? data.phase ?? ""}）`;
}

/** Task card summary (searchableContent/notification visible). */
export function summarizeTasks(data: AgentTaskProgressPayload): string {
  const running = data.tasks.filter((t) => t.status === "running").length;
  const total = data.tasks.length;
  if (total === 0) return "🧩 任务：无";
  return running > 0 ? `🧩 任务 ${total}（${running} 运行中）` : `🧩 任务 ${total}（${data.tasks.every((t) => t.status === "failed") ? "全部失败" : "全部完成"}）`;
}
