/**
 * @wildfirechat/dsh-mail
 *
 * The model-facing half of the Wildfire mail integration. It talks to the
 * loopback Mail Bridge owned by the Electron main process; mailbox credentials
 * never enter the DSH Host or the model context.
 */
export const name = "dsh-mail";
export const inject = ["tools"];

const OUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{
    type: "text",
    text: (() => {
      try {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        return text.length > 30000 ? `${text.slice(0, 30000)}…` : text;
      } catch {
        return String(value);
      }
    })(),
  }],
};

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: OUT,
    async execute(args, exec) {
      return execute(args || {}, exec || {});
    },
  };
}

function bridgeInfo() {
  const url = String(process.env.WF_MAIL_BRIDGE_URL || "").trim();
  const token = String(process.env.WF_MAIL_BRIDGE_TOKEN || "").trim();
  if (!url || !token) throw new Error("mail bridge is not enabled for this Host session");
  return { url: url.replace(/\/+$/, ""), token };
}

async function call(path, body = {}) {
  const { url, token } = bridgeInfo();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dsh-mail-token": token,
    },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const message = data && data.error && data.error.message ? data.error.message : `mail bridge HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

async function requireSendApproval(ctx, exec, toolName, reason) {
  const approval = typeof ctx.get === "function" ? ctx.get("approval") : ctx.approval;
  if (!approval || typeof approval.request !== "function") {
    throw new Error("邮件发送审批服务不可用，已拒绝发送");
  }
  if (!exec || !exec.agent) throw new Error("邮件发送只能在 Agent 会话中执行");
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  });
  if (outcome !== "allowed-once") {
    throw new Error(`邮件未发送：owner 审批结果为 ${outcome}`);
  }
}

const ACCOUNT = {
  type: "string",
  description: "Mailbox account id from mail_accounts; omit when only one account is configured.",
};
const FOLDER = {
  type: "string",
  description: "Folder name or path; defaults to INBOX.",
};

function accountArgs(extra = {}) {
  return {
    type: "object",
    properties: { account: ACCOUNT, ...extra },
    additionalProperties: false,
  };
}

export function apply(ctx) {
  ctx.tools.register(tool(
    "mail_accounts",
    "List configured mailbox accounts (address and display name only; secrets are never returned).",
    { type: "object", properties: {}, additionalProperties: false },
    async () => {
      // DSH validates every tool output as an object; wrap the bridge array.
      const accounts = await call("/mail/accounts", {});
      return { accounts: Array.isArray(accounts) ? accounts : [] };
    }
  ));

  ctx.tools.register(tool(
    "mail_folders",
    "List mailbox folders for a configured account.",
    accountArgs(),
    async (args) => {
      const folders = await call("/mail/folders", { account: args.account });
      return { account: args.account || "", folders: Array.isArray(folders) ? folders : [] };
    }
  ));

  ctx.tools.register(tool(
    "mail_list",
    "List mail headers newest-first in a folder with offset pagination. Bodies are not downloaded.",
    accountArgs({
      folder: FOLDER,
      limit: { type: "integer", description: "1-100, default 20." },
      offset: { type: "integer", description: "Number of newest messages to skip; use 0, 20, 40... to page." },
      unread_only: { type: "boolean" },
    }),
    async (args) => call("/mail/list", {
      account: args.account,
      folder: args.folder || "INBOX",
      limit: args.limit,
      offset: args.offset,
      unreadOnly: args.unread_only === true,
    })
  ));

  ctx.tools.register(tool(
    "mail_search",
    "Search mail headers/body on the mail server, newest-first, with offset pagination. Uses IMAP SEARCH; exact syntax support varies by provider.",
    accountArgs({
      folder: FOLDER,
      query: { type: "string", description: "Text to search for. Chinese text is supported when the server advertises UTF-8." },
      limit: { type: "integer", description: "1-100, default 20." },
      offset: { type: "integer", description: "Number of newest matches to skip." },
    }),
    async (args) => call("/mail/search", {
      account: args.account,
      folder: args.folder || "INBOX",
      query: String(args.query || ""),
      limit: args.limit,
      offset: args.offset,
    })
  ));

  ctx.tools.register(tool(
    "mail_read",
    "Read one message body (text), headers and attachment metadata. Does not download attachment bytes.",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer", description: "IMAP UID returned by mail_list/mail_search." },
      mark_seen: { type: "boolean", description: "Mark the message as seen; default false." },
    }),
    async (args) => call("/mail/read", {
      account: args.account,
      folder: args.folder || "INBOX",
      uid: args.uid,
      markSeen: args.mark_seen === true,
    })
  ));

  ctx.tools.register(tool(
    "mail_get_attachment",
    "Save one attachment from a message into the DSH workspace and return the local path. The output path must stay inside the workspace.",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer" },
      part: { type: "string", description: "Attachment part id returned by mail_read." },
      output: { type: "string", description: "Workspace path to save the attachment to." },
    }),
    async (args) => call("/mail/attachment", {
      account: args.account,
      folder: args.folder || "INBOX",
      uid: args.uid,
      part: args.part,
      output: args.output,
    })
  ));

  ctx.tools.register(tool(
    "mail_draft",
    "Save a message to the Drafts folder without sending it. Attachments must be workspace files.",
    accountArgs({
      to: { type: "string" },
      cc: { type: "string" },
      bcc: { type: "string" },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      attachments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, filename: { type: "string" } }, required: ["path"], additionalProperties: false } },
    }),
    async (args) => call("/mail/draft", {
      account: args.account,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.text,
      html: args.html,
      attachments: args.attachments,
    })
  ));

  ctx.tools.register(tool(
    "mail_send",
    "Send a new email as the configured account. Requires one-shot owner approval before SMTP sends.",
    accountArgs({
      to: { type: "string" },
      cc: { type: "string" },
      bcc: { type: "string" },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
      attachments: { type: "array", items: { type: "object", properties: { path: { type: "string" }, filename: { type: "string" } }, required: ["path"], additionalProperties: false } },
    }),
    async (args, exec) => {
      await requireSendApproval(ctx, exec, "mail_send", `发送邮件到 ${args.to || ""}，主题：${args.subject || ""}`);
      return call("/mail/send", {
        account: args.account,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments: args.attachments,
      });
    }
  ));

  ctx.tools.register(tool(
    "mail_reply",
    "Reply to a message. Requires one-shot owner approval before SMTP sends.",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer" },
      text: { type: "string" },
      reply_all: { type: "boolean" },
      html: { type: "boolean" },
    }),
    async (args, exec) => {
      await requireSendApproval(ctx, exec, "mail_reply", `回复邮件 uid=${args.uid}（folder=${args.folder || "INBOX"}）`);
      return call("/mail/reply", {
        account: args.account,
        folder: args.folder || "INBOX",
        uid: args.uid,
        text: args.text,
        replyAll: args.reply_all === true,
        html: args.html === true,
      });
    }
  ));

  ctx.tools.register(tool(
    "mail_forward",
    "Forward a message. Requires one-shot owner approval before SMTP sends.",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer" },
      to: { type: "string" },
      text: { type: "string" },
    }),
    async (args, exec) => {
      await requireSendApproval(ctx, exec, "mail_forward", `转发邮件 uid=${args.uid} 到 ${args.to || ""}`);
      return call("/mail/forward", {
        account: args.account,
        folder: args.folder || "INBOX",
        uid: args.uid,
        to: args.to,
        text: args.text,
      });
    }
  ));

  ctx.tools.register(tool(
    "mail_mark",
    "Change IMAP flags on a message (seen/unseen/flagged/unflagged).",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer" },
      flags: { type: "array", items: { type: "string", enum: ["seen", "unseen", "flagged", "unflagged"] } },
    }),
    async (args) => call("/mail/mark", {
      account: args.account,
      folder: args.folder || "INBOX",
      uid: args.uid,
      flags: args.flags,
    })
  ));

  ctx.tools.register(tool(
    "mail_move",
    "Move a message to another folder.",
    accountArgs({
      folder: FOLDER,
      uid: { type: "integer" },
      target_folder: { type: "string" },
    }),
    async (args) => call("/mail/move", {
      account: args.account,
      folder: args.folder || "INBOX",
      uid: args.uid,
      targetFolder: args.target_folder,
    })
  ));
}
