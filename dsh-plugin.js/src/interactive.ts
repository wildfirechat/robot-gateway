/**
 * Interactive seams: bridge dsh's human-in-the-loop surfaces to Wildfire IM
 * using the structured DSH card protocol (types 200-206).
 *
 * - ask_user → DSH_Question card (200); user replies via DSH_Answer (201)
 *   or plain text (custom answer fallback)
 * - tool approval → DSH_Approval card (202); user replies via
 *   DSH_ApprovalResult (203)
 * - cards are updated in place via updateMessage (answered / approved /
 *   rejected / expired)
 *
 * Deployment note: `ctx.userQuestions` allows ONE provider per context. In the
 * `dsh web` profile the Host apiproxy already registers one, so our
 * registration throws `DUPLICATE_PROVIDER` there — we catch it, log, and rely
 * on the GUI. In an IM-first custom profile we are the only provider.
 */

import { randomUUID } from "node:crypto";
import type { WildfireConfig } from "./config.js";
import { getInteractionConfig } from "./config.js";
import {
  DSH_TYPE,
  summarizeApproval,
  summarizeGoal,
  summarizeQuestion,
  type DSHAnswerPayload,
  type DSHApprovalPayload,
  type DSHApprovalResultPayload,
  type DSHGoalPayload,
  type DSHQuestionItem,
  type DSHQuestionPayload,
} from "./protocol.js";

/** Agent runtime state, pushed via the scope=31 conversation user setting. */
export interface RuntimeState {
  state?: "idle" | "running" | "waiting_user" | "done";
  phase?: "thinking" | "tool" | "done";
  toolName?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Where to deliver a card/text for a conversation. */
export interface ConversationTarget {
  sender: string;
  conv: { type: number; target: string; line: number };
}

/** Resolve the IM conversation key for a dsh session id. */
export type SessionKeyResolver = (sessionId: string) => string | undefined;

/** Resolve the sender who owns the in-flight turn of a conversation. */
export type TurnOwnerResolver = (key: string) => string | undefined;

/** IM send surface (wired in index.ts). */
export interface CardSender {
  sendText(target: ConversationTarget, text: string): Promise<void>;
  /** Send a card; returns the messageId for later updateMessage, if available. */
  sendCard(
    target: ConversationTarget,
    type: number,
    data: unknown,
    summary: string,
    persistFlag: number
  ): Promise<string | undefined>;
  updateCard(messageId: string, type: number, data: unknown, summary: string): Promise<void>;
  /**
   * Set the conversation-scoped user setting carrying the agent runtime state
   * (scope=31, type=1 状态). Carries what used to be DSH_Status/DSH_Progress
   * messages so the whole group sees the state via user settings instead of
   * the message feed.
   */
  setConversationState(key: string, payload: Record<string, unknown>): Promise<void>;
}

interface PendingQuestion {
  key: string;
  qid: string;
  questions: any[];
  resolve: (value: any) => void;
  timer: NodeJS.Timeout;
  ownerSender?: string;
  cardMessageId?: string;
}

interface PendingApproval {
  key: string;
  aid: string;
  resolve: (value: string) => void;
  timer: NodeJS.Timeout;
  ownerSender?: string;
  cardMessageId?: string;
}

/** Card status payloads for updateMessage (button states). */
function cardStatusPayload(kind: "question" | "approval", state: string): any {
  return { cardKind: kind, state };
}

export class InteractionManager {
  private config: Required<ReturnType<typeof getInteractionConfig>>;
  private logger: any;
  private cards: CardSender;
  private resolveKeyForSession: SessionKeyResolver;
  private resolveTurnOwner: TurnOwnerResolver;
  private conversations = new Map<string, ConversationTarget>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private registered = false;
  // Conversation state accumulator (scope=31 user setting), coalesced 300ms.
  private stateTimer: NodeJS.Timeout | undefined;
  private pendingState:
    | { key: string; state?: string; phase?: string; toolName?: string; model?: string; reasoningEffort?: string }
    | undefined;

  constructor(
    config: WildfireConfig,
    logger: any,
    cards: CardSender,
    resolveKeyForSession: SessionKeyResolver = () => undefined,
    resolveTurnOwner: TurnOwnerResolver = () => undefined
  ) {
    this.config = getInteractionConfig(config);
    this.logger = logger;
    this.cards = cards;
    this.resolveKeyForSession = resolveKeyForSession;
    this.resolveTurnOwner = resolveTurnOwner;
  }

  /** Remember where to reply for a conversation (updated on every inbound message). */
  remember(key: string, sender: string, conv: { type: number; target: string; line: number }): void {
    this.conversations.set(key, { sender, conv });
  }

  getConversation(key: string): ConversationTarget | undefined {
    return this.conversations.get(key);
  }

  /**
   * Register the userQuestions provider and the approval answerer.
   * Safe to call once; swallows DUPLICATE_PROVIDER from the web profile.
   */
  register(ctx: any): void {
    if (this.registered) return;
    this.registered = true;

    if (this.config.askUserEnabled) {
      try {
        const userQuestions = ctx.get("userQuestions");
        userQuestions?.registerProvider?.({
          ask: async (request: any) => {
            const key = request?.agent
              ? this.resolveKeyForSession(String(request.agent.session?.id))
              : undefined;
            if (!key) throw new Error("no wildfire conversation for this agent");
            return this.ask(key, request);
          },
        });
        this.logger?.info?.("[wildfire] userQuestions provider registered (ask_user via IM)");
      } catch (err: any) {
        if (String(err?.code ?? err?.message ?? err).includes("DUPLICATE_PROVIDER")) {
          this.logger?.warn?.(
            "[wildfire] userQuestions provider already registered (web profile); GUI answers questions"
          );
        } else {
          this.logger?.warn?.(`[wildfire] userQuestions provider registration failed: ${String(err)}`);
        }
      }
    }

    if (this.config.approvalEnabled) {
      ctx.on("approval/request", async (req: any, next: () => Promise<string>) => {
        const key = req?.agent ? this.resolveKeyForSession(String(req.agent.session?.id)) : undefined;
        if (!key) return next();
        try {
          return await this.requestApproval(key, req);
        } catch (err: any) {
          this.logger?.warn?.(`[wildfire] approval answerer failed: ${String(err)}`);
          return "unavailable";
        }
      });
      this.logger?.info?.("[wildfire] approval answerer registered (approvals via IM)");
    }
  }

  /**
   * Handle a structured DSH_Answer (201). Returns true when consumed.
   * Plain text replies are handled by `handleTextReply`.
   */
  handleAnswer(key: string, payload: DSHAnswerPayload, sender: string, isAdmin = false): boolean {
    const question = this.pendingQuestions.get(key);
    if (!question || question.qid !== payload.qid) return false;
    if (!isAdmin && question.ownerSender && sender && sender !== question.ownerSender) {
      return false; // bystander cannot answer
    }
    this.pendingQuestions.delete(key);
    clearTimeout(question.timer);
    const answer = this.normalizeAnswers(payload, question.questions);
    question.resolve(answer);
    this.updateCardState(question.cardMessageId, "question", "answered");
    this.pushStatus(key, { state: "running" });
    return true;
  }

  /**
   * Handle a structured DSH_ApprovalResult (203). Returns true when consumed.
   */
  handleApprovalResult(
    key: string,
    payload: DSHApprovalResultPayload,
    sender: string,
    isAdmin = false
  ): boolean {
    const approval = this.pendingApprovals.get(key);
    if (!approval || approval.aid !== payload.aid) return false;
    if (!isAdmin && approval.ownerSender && sender && sender !== approval.ownerSender) {
      return false;
    }
    this.pendingApprovals.delete(key);
    clearTimeout(approval.timer);
    const outcome = payload.action === "approve" ? "allowed-once" : "rejected";
    approval.resolve(outcome);
    this.updateCardState(approval.cardMessageId, "approval", outcome === "allowed-once" ? "approved" : "rejected");
    this.pushStatus(key, { state: "running" });
    return true;
  }

  /**
   * Handle a plain-text reply: if a card is pending for this conversation the
   * text is the custom answer; otherwise false (message flows to the agent).
   */
  handleTextReply(key: string, text: string, sender: string, isAdmin = false): boolean {
    const question = this.pendingQuestions.get(key);
    if (question) {
      if (!isAdmin && question.ownerSender && sender && sender !== question.ownerSender) {
        return false;
      }
      this.pendingQuestions.delete(key);
      clearTimeout(question.timer);
      question.resolve(this.parseTextAnswer(text, question.questions));
      this.updateCardState(question.cardMessageId, "question", "answered");
      this.pushStatus(key, { state: "running" });
      return true;
    }
    const approval = this.pendingApprovals.get(key);
    if (approval) {
      if (!isAdmin && approval.ownerSender && sender && sender !== approval.ownerSender) {
        return false;
      }
      this.pendingApprovals.delete(key);
      clearTimeout(approval.timer);
      approval.resolve(this.parseApproval(text));
      this.updateCardState(approval.cardMessageId, "approval", this.parseApproval(text) === "allowed-once" ? "approved" : "rejected");
      this.pushStatus(key, { state: "running" });
      return true;
    }
    return false;
  }

  /** Whether a pending interaction waits on this conversation (query only). */
  hasPending(key: string): boolean {
    return this.pendingQuestions.has(key) || this.pendingApprovals.has(key);
  }

  /**
   * Expire the conversation's pending cards (question/approval) and resolve
   * the blocked agent waits — used by `/stop` so no zombie cards or hanging
   * asks remain after the turn is cancelled. Returns how many cards expired.
   */
  expirePending(key: string): number {
    let count = 0;
    const question = this.pendingQuestions.get(key);
    if (question) {
      this.pendingQuestions.delete(key);
      clearTimeout(question.timer);
      question.resolve({ answers: [] });
      this.updateCardState(question.cardMessageId, "question", "expired");
      count++;
    }
    const approval = this.pendingApprovals.get(key);
    if (approval) {
      this.pendingApprovals.delete(key);
      clearTimeout(approval.timer);
      approval.resolve("cancelled");
      this.updateCardState(approval.cardMessageId, "approval", "expired");
      count++;
    }
    return count;
  }

  /**
   * Update the conversation runtime state via the scope=31 user setting
   * (type=1 状态). Coalesced within 300ms; group members see the state in
   * their user settings instead of the message feed.
   */
  pushStatus(key: string, data: RuntimeState): void {
    this.logger?.info?.(`[wildfire] pushStatus: key=${key}, state=${data.state}`);
    const acc = this.pendingState ?? { key };
    acc.key = key;
    if (data.state) acc.state = data.state;
    if (data.model) acc.model = data.model;
    if (data.reasoningEffort) acc.reasoningEffort = data.reasoningEffort;
    this.pendingState = acc;
    this.scheduleStateFlush();
  }

  /** Merge agent activity (thinking/tool) into the runtime state. */
  pushProgress(key: string, data: RuntimeState): void {
    const acc = this.pendingState ?? { key };
    acc.key = key;
    if (data.phase) acc.phase = data.phase;
    if (data.toolName) acc.toolName = data.toolName;
    this.pendingState = acc;
    this.scheduleStateFlush();
  }

  private scheduleStateFlush(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.flushState();
    }, 300);
    this.stateTimer.unref?.();
  }

  private flushState(): void {
    const acc = this.pendingState;
    this.pendingState = undefined;
    if (!acc) return;
    const payload: Record<string, unknown> = { state: acc.state ?? "running" };
    if (acc.phase && payload.state !== "done" && payload.state !== "idle") {
      payload.phase = acc.phase;
    }
    if (acc.toolName && payload.state !== "done") payload.toolName = acc.toolName;
    if (acc.model) payload.model = acc.model;
    if (acc.reasoningEffort) payload.reasoningEffort = acc.reasoningEffort;
    this.cards
      .setConversationState(acc.key, payload)
      .catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire] conversation state update failed: ${String(err)}`)
      );
  }

  /** Send a goal card (DSH_Goal) to a conversation. */
  sendGoal(key: string, data: DSHGoalPayload): void {
    const target = this.getConversation(key);
    if (!target) return;
    this.cards
      .sendCard(target, DSH_TYPE.GOAL, data, summarizeGoal(data), 1)
      .catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire] goal card send failed: ${String(err)}`)
      );
  }

  /** Reset everything (plugin stop). */
  dispose(): void {
    for (const pending of this.pendingQuestions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ answers: [] });
      this.updateCardState(pending.cardMessageId, "question", "expired");
    }
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.resolve("unavailable");
      this.updateCardState(pending.cardMessageId, "approval", "expired");
    }
    this.pendingQuestions.clear();
    this.pendingApprovals.clear();
    this.conversations.clear();
  }

  /** Ask the questions to the IM user via a DSH_Question card. */
  private async ask(key: string, request: any): Promise<any> {
    const target = this.getConversation(key);
    if (!target) throw new Error(`no conversation target for ${key}`);
    if (this.pendingQuestions.has(key)) {
      throw new Error("another question is already waiting for this conversation");
    }

    const questions = request?.questions ?? [];
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("ask requires at least one question");
    }
    const qid = randomUUID();
    const data: DSHQuestionPayload = { qid, questions };
    let cardMessageId: string | undefined;
    try {
      cardMessageId = await this.cards.sendCard(
        target,
        DSH_TYPE.QUESTION,
        data,
        summarizeQuestion(data),
        1
      );
    } catch (err: any) {
      this.logger?.warn?.(`[wildfire] question card send failed, falling back to text: ${err.message}`);
      await this.cards.sendText(
        target,
        `🤔 需要你确认：\n${this.formatQuestions(questions)}\n\n直接回复即可（可附说明）`
      );
    }

    this.pushStatus(key, { state: "waiting_user" });
    const ownerSender = this.resolveTurnOwner(key) ?? target.sender;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(key);
        this.logger?.warn?.(`[wildfire] ask_user timed out: key=${key}`);
        this.updateCardState(cardMessageId, "question", "expired");
        this.pushStatus(key, { state: "running" });
        resolve({ answers: [] });
      }, this.config.askUserTimeoutMs);
      timer.unref?.();
      this.pendingQuestions.set(key, { key, qid, questions, resolve, timer, ownerSender, cardMessageId });
    });
  }

  /**
   * One-off question card outside the agent ask_user flow — used by commands
   * such as `/cwd` create-confirmation. Same DSH_Question card + text-answer
   * machinery as `ask()`, but resolves with the raw DSHAnswerPayload (or null
   * on timeout / when another card is already pending for this conversation).
   */
  async askDirect(
    key: string,
    questions: DSHQuestionItem[],
    opts: { timeoutMs?: number; ownerSender?: string } = {}
  ): Promise<DSHAnswerPayload | null> {
    const target = this.getConversation(key);
    if (!target) return null;
    if (this.pendingQuestions.has(key)) {
      this.logger?.warn?.(`[wildfire] askDirect skipped: another question pending for ${key}`);
      return null;
    }
    if (!Array.isArray(questions) || questions.length === 0) return null;

    const qid = randomUUID();
    const data: DSHQuestionPayload = { qid, questions };
    let cardMessageId: string | undefined;
    try {
      cardMessageId = await this.cards.sendCard(
        target,
        DSH_TYPE.QUESTION,
        data,
        summarizeQuestion(data),
        1
      );
    } catch (err: any) {
      this.logger?.warn?.(`[wildfire] askDirect card send failed, falling back to text: ${err.message}`);
      await this.cards.sendText(
        target,
        `🤔 需要你确认：\n${this.formatQuestions(questions)}\n\n直接回复即可（可附说明）`
      );
    }

    this.pushStatus(key, { state: "waiting_user" });
    const ownerSender = opts.ownerSender ?? target.sender;
    const timeoutMs = opts.timeoutMs ?? this.config.askUserTimeoutMs;
    return new Promise<DSHAnswerPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(key);
        this.logger?.warn?.(`[wildfire] askDirect timed out: key=${key}`);
        this.updateCardState(cardMessageId, "question", "expired");
        this.pushStatus(key, { state: "running" });
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pendingQuestions.set(key, {
        key,
        qid,
        questions,
        resolve: (value: any) => resolve(value as DSHAnswerPayload),
        timer,
        ownerSender,
        cardMessageId,
      });
    });
  }

  /** Ask the IM user to approve/deny one tool action via a DSH_Approval card. */
  private async requestApproval(key: string, req: any): Promise<string> {
    const target = this.getConversation(key);
    if (!target) return "unavailable";
    if (this.pendingApprovals.has(key)) return "unavailable";

    const aid = randomUUID();
    const data: DSHApprovalPayload = {
      aid,
      toolName: req?.toolName ?? "工具",
      ...(req?.reason ? { reason: req.reason } : {}),
    };
    let cardMessageId: string | undefined;
    try {
      cardMessageId = await this.cards.sendCard(
        target,
        DSH_TYPE.APPROVAL,
        data,
        summarizeApproval(data),
        1
      );
    } catch (err: any) {
      this.logger?.warn?.(`[wildfire] approval card send failed, falling back to text: ${err.message}`);
      await this.cards.sendText(
        target,
        `🔐 工具审批：${data.toolName} 请求执行${data.reason ? `\n原因: ${data.reason}` : ""}\n\n回复「${this.config.approvedLabel}」放行，或「${this.config.deniedLabel}」拒绝`
      );
    }

    this.pushStatus(key, { state: "waiting_user" });
    const ownerSender = this.resolveTurnOwner(key) ?? target.sender;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(key);
        this.logger?.warn?.(`[wildfire] approval timed out: key=${key}`);
        this.updateCardState(cardMessageId, "approval", "expired");
        this.pushStatus(key, { state: "running" });
        resolve("cancelled");
      }, this.config.approvalTimeoutMs);
      timer.unref?.();
      this.pendingApprovals.set(key, { key, aid, resolve, timer, ownerSender, cardMessageId });
    });
  }

  /** Update a card's state in place via updateMessage (best effort). */
  private updateCardState(messageId: string | undefined, kind: "question" | "approval", state: string): void {
    if (!messageId) return;
    this.cards
      .updateCard(messageId, kind === "question" ? DSH_TYPE.QUESTION : DSH_TYPE.APPROVAL, cardStatusPayload(kind, state), state)
      .catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire] card state update failed: ${String(err)}`)
      );
  }

  /** Normalize a structured DSH_Answer against the original questions. */
  private normalizeAnswers(payload: DSHAnswerPayload, questions: any[]): any {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const answers = (payload.answers ?? []).map((a) => {
      const q = byId.get(a.id);
      const options: Array<{ label: string }> = Array.isArray(q?.options) ? q.options : [];
      const selected = (a.selected ?? []).filter((label) =>
        options.length === 0 || options.some((o) => o.label === label)
      );
      return { id: a.id, selected, ...(a.custom ? { custom: a.custom } : {}) };
    });
    return { answers };
  }

  /** Parse a plain-text reply into the userQuestions answer shape. */
  private parseTextAnswer(text: string, questions: any[]): any {
    const answers = questions.map((q, i) => {
      const id = q.id ?? `q${i + 1}`;
      const options: Array<{ label: string }> = Array.isArray(q.options) ? q.options : [];
      const isMulti = Boolean(q.multiSelect);
      if (options.length === 0) {
        return { id, selected: [], custom: text };
      }
      const parts = isMulti ? text.split(/[,，、\s]+/) : [text];
      const selected: string[] = [];
      let custom: string | undefined;
      for (const part of parts) {
        const trimmed = part.trim();
        const byLabel = options.find((o) => o.label === trimmed);
        const byIndex = /^\d+$/.test(trimmed) ? options[Number(trimmed) - 1] : undefined;
        if (byLabel) selected.push(byLabel.label);
        else if (byIndex) selected.push(byIndex.label);
        else if (isMulti) custom = trimmed;
        else {
          custom = trimmed;
          break;
        }
      }
      return { id, selected, ...(custom !== undefined ? { custom } : {}) };
    });
    return { answers };
  }

  /** Parse a plain-text reply into an approval outcome. */
  private parseApproval(text: string): string {
    const t = text.trim();
    const approved = this.config.approvedLabel;
    const denied = this.config.deniedLabel;
    if (approved && t.includes(approved)) return "allowed-once";
    if (denied && t.includes(denied)) return "rejected";
    if (/^(是|好|ok|yes|允许|同意|放行|可以|1)/i.test(t)) return "allowed-once";
    if (/^(否|不|no|不行|不要|拒绝|不允许|0)/i.test(t)) return "rejected";
    return "unavailable";
  }

  /** Format questions for the text fallback. */
  private formatQuestions(questions: any[]): string {
    return questions
      .map((q, qi) => {
        const header = q.header ? `【${q.header}】` : "";
        const detail = q.detail ? `\n${q.detail}` : "";
        const options =
          Array.isArray(q.options) && q.options.length > 0
            ? `\n选项: ${q.options.map((o: any, oi: number) => `${oi + 1}. ${o.label}`).join(" / ")}${q.multiSelect ? "（可多选，逗号分隔）" : ""}`
            : "";
        return `${qi + 1}. ${header}${q.question}${detail}${options}`;
      })
      .join("\n");
  }
}
