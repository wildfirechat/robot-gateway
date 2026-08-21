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
  // 207-209 保留：扩展（如 DSH_ToolResult、DSH_Command）
  GOAL: 206, // 机器人→用户 目标进度卡片
} as const;

export type DSHType = (typeof DSH_TYPE)[keyof typeof DSH_TYPE];

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
