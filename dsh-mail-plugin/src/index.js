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
    async () => call("/mail/accounts", {})
  ));

  ctx.tools.register(tool(
    "mail_folders",
    "List mailbox folders for a configured account.",
    accountArgs(),
    async (args) => call("/mail/folders", { account: args.account })
  ));

  ctx.tools.register(tool(
    "mail_list",
    "List recent mail headers in a folder. Bodies are not downloaded.",
    accountArgs({
      folder: FOLDER,
      limit: { type: "integer", description: "1-100, default 20." },
      unread_only: { type: "boolean" },
    }),
    async (args) => call("/mail/list", {
      account: args.account,
      folder: args.folder || "INBOX",
      limit: args.limit,
      unreadOnly: args.unread_only === true,
    })
  ));

  ctx.tools.register(tool(
    "mail_search",
    "Search mail headers/body on the mail server. Uses IMAP SEARCH; exact syntax support varies by provider.",
    accountArgs({
      folder: FOLDER,
      query: { type: "string", description: "Text to search for. Chinese text is supported when the server advertises UTF-8." },
      limit: { type: "integer", description: "1-100, default 20." },
    }),
    async (args) => call("/mail/search", {
      account: args.account,
      folder: args.folder || "INBOX",
      query: String(args.query || ""),
      limit: args.limit,
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
}
