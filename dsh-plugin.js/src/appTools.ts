/**
 * Application-service tools exposed through the existing IM bridge.
 *
 * The bridge runs in the Electron renderer, where the logged-in wfc session
 * can call APP_SERVER, Organization, Poll and Collection APIs with the current
 * user's authToken/authCode. This module is only the model-facing layer; no
 * auth token or service credential crosses into DSH Host context.
 */
import { confirmWriteAction, markReadResultTainted, requireOwnerTurn, requireWriteTurn } from "./toolSecurity.js";

type Bridge = { url: string; token: string };
let bridgeCache: Bridge | null | undefined;

function bridge(): Bridge | null {
  if (bridgeCache !== undefined) return bridgeCache;
  const url = String(process.env.WF_IM_BRIDGE_URL || "").trim();
  const token = String(process.env.WF_IM_BRIDGE_TOKEN || "").trim();
  bridgeCache = url && token ? { url: url.replace(/\/+$/, ""), token } : null;
  return bridgeCache;
}

async function call(method: string, args: Record<string, unknown>): Promise<any> {
  const config = bridge();
  if (!config) throw new Error("application service bridge is not enabled for this Host session");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("application service bridge timeout")), 20000);
  try {
    const response = await fetch(`${config.url}/app/call`, {
      method: "POST",
      headers: {
        "X-DSH-Bridge-Token": config.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, args }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || `application service bridge HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const OUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args: any, value: any) => [{
    type: "text",
    text: (() => {
      try {
        const text = JSON.stringify(value);
        return text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
      } catch {
        return String(value);
      }
    })(),
  }],
};

type ToolDef = {
  name: string;
  method: string;
  description: string;
  parameters: any;
  write?: boolean;
  preview?: (args: any) => string;
};

const OBJ = (properties: Record<string, any>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });
const B = (description: string) => ({ type: "boolean", description });
const A = (description: string, items: any = { type: "string" }) => ({ type: "array", description, items });

const DEFS: ToolDef[] = [
  // Group announcement
  { name: "app_group_announcement_get", method: "groupAnnouncement.get", description: "Read a Wildfire group announcement.", parameters: OBJ({ groupId: S("Group id.") }, ["groupId"]) },
  { name: "app_group_announcement_put", method: "groupAnnouncement.put", description: "Update a Wildfire group announcement. Requires owner confirmation.", parameters: OBJ({ groupId: S("Group id."), text: S("New announcement text."), author: S("Optional author user id; defaults to current user.") }, ["groupId", "text"]), write: true, preview: (a) => `更新群公告 ${a.groupId}\n${String(a.text || "").slice(0, 500)}` },

  // Favorites
  { name: "app_fav_list", method: "fav.list", description: "List the current user's favorites (messages/files).", parameters: OBJ({ id: I("Pagination cursor from a previous result; omit for first page."), count: I("Page size, 1-100.") }) },
  { name: "app_fav_add", method: "fav.add", description: "Add a message/file to the current user's favorites. Requires owner confirmation.", parameters: OBJ({ item: { type: "object", additionalProperties: true, description: "Favorite fields accepted by APP_SERVER /fav/add." } }, ["item"]), write: true, preview: (a) => `添加收藏\n${JSON.stringify(a.item || {}).slice(0, 500)}` },
  { name: "app_fav_delete", method: "fav.delete", description: "Delete one favorite by id. Requires owner confirmation.", parameters: OBJ({ favId: I("Favorite id.") }, ["favId"]), write: true, preview: (a) => `删除收藏 ${a.favId}` },

  // Conference
  { name: "app_conference_my_id", method: "conference.myId", description: "Get the current user's private conference id.", parameters: OBJ({}) },
  { name: "app_conference_get_id", method: "conference.getId", description: "Get a user's private conference id.", parameters: OBJ({ userId: S("User id.") }, ["userId"]) },
  { name: "app_conference_create", method: "conference.create", description: "Create a conference. Requires owner confirmation. Do not set info.owner; the client fills it with the current user. PIN is 1-5 digits.", parameters: OBJ({ info: { type: "object", additionalProperties: true, description: "Conference fields accepted by APP_SERVER; owner is set by the client." } }, ["info"]), write: true, preview: (a) => `创建会议\n${JSON.stringify(a.info || {}).slice(0, 500)}` },
  { name: "app_conference_info", method: "conference.info", description: "Query conference details.", parameters: OBJ({ conferenceId: S("Conference id."), password: S("Optional password.") }, ["conferenceId"]) },
  { name: "app_conference_update", method: "conference.update", description: "Update conference details. Requires owner confirmation; owner is set by the client.", parameters: OBJ({ info: { type: "object", additionalProperties: true, description: "Conference fields accepted by APP_SERVER." } }, ["info"]), write: true, preview: (a) => `更新会议\n${JSON.stringify(a.info || {}).slice(0, 500)}` },
  { name: "app_conference_destroy", method: "conference.destroy", description: "Destroy a conference. Requires owner confirmation.", parameters: OBJ({ conferenceId: S("Conference id.") }, ["conferenceId"]), write: true, preview: (a) => `结束会议 ${a.conferenceId}` },
  { name: "app_conference_recording", method: "conference.recording", description: "Set conference recording flag. Requires owner confirmation.", parameters: OBJ({ conferenceId: S("Conference id."), recording: B("Recording enabled.") }, ["conferenceId", "recording"]), write: true, preview: (a) => `${a.recording ? "开启" : "关闭"}会议录音 ${a.conferenceId}` },
  { name: "app_conference_focus", method: "conference.focus", description: "Set conference focus user. Requires owner confirmation.", parameters: OBJ({ conferenceId: S("Conference id."), userId: S("Focus user id; empty clears.") }, ["conferenceId"]), write: true, preview: (a) => `设置会议焦点 ${a.conferenceId} -> ${a.userId || "(clear)"}` },
  { name: "app_conference_favorite", method: "conference.favorite", description: "Favorite a conference. Requires owner confirmation.", parameters: OBJ({ conferenceId: S("Conference id.") }, ["conferenceId"]), write: true, preview: (a) => `收藏会议 ${a.conferenceId}` },
  { name: "app_conference_unfavorite", method: "conference.unfavorite", description: "Unfavorite a conference. Requires owner confirmation.", parameters: OBJ({ conferenceId: S("Conference id.") }, ["conferenceId"]), write: true, preview: (a) => `取消收藏会议 ${a.conferenceId}` },
  { name: "app_conference_is_favorite", method: "conference.isFavorite", description: "Check whether a conference is favorited.", parameters: OBJ({ conferenceId: S("Conference id.") }, ["conferenceId"]) },
  { name: "app_conference_favorites", method: "conference.favorites", description: "List favorite conferences.", parameters: OBJ({}) },
  { name: "app_conference_quota", method: "conference.quota", description: "Query conference quota.", parameters: OBJ({}) },

  // Poll
  { name: "app_poll_create", method: "poll.create", description: "Create a group poll. Requires owner confirmation.", parameters: OBJ({ groupId: S("Group id."), title: S("Poll title."), description: S("Optional description."), options: A("Option texts."), visibility: I("1 group-only, 2 public."), type: I("1 single choice, 2 multiple choice."), maxSelect: I("Maximum choices for multiple-choice."), anonymous: I("0 named, 1 anonymous."), endTime: I("End time ms; 0 = none."), showResult: I("0 hide before vote, 1 always show.") }, ["groupId", "title", "options"]), write: true, preview: (a) => `创建投票「${a.title}」\n选项：${(a.options || []).join(" / ")}` },
  { name: "app_poll_get", method: "poll.get", description: "Read poll details.", parameters: OBJ({ pollId: I("Poll id."), groupId: S("Optional group id.") }, ["pollId"]) },
  { name: "app_poll_vote", method: "poll.vote", description: "Vote in a poll. Requires owner confirmation.", parameters: OBJ({ pollId: I("Poll id."), groupId: S("Optional group id."), optionIds: A("Option ids.", { type: "integer" }) }, ["pollId", "optionIds"]), write: true, preview: (a) => `参与投票 ${a.pollId}，选项 ${(a.optionIds || []).join(",")}` },
  { name: "app_poll_close", method: "poll.close", description: "Close a poll. Requires owner confirmation.", parameters: OBJ({ pollId: I("Poll id."), groupId: S("Optional group id.") }, ["pollId"]), write: true, preview: (a) => `结束投票 ${a.pollId}` },
  { name: "app_poll_delete", method: "poll.delete", description: "Delete a poll. Requires owner confirmation.", parameters: OBJ({ pollId: I("Poll id."), groupId: S("Optional group id.") }, ["pollId"]), write: true, preview: (a) => `删除投票 ${a.pollId}` },
  { name: "app_poll_export", method: "poll.export", description: "Export named poll details.", parameters: OBJ({ pollId: I("Poll id."), groupId: S("Optional group id.") }, ["pollId"]) },
  { name: "app_poll_my", method: "poll.my", description: "List polls created by the current user.", parameters: OBJ({}) },

  // Collection
  { name: "app_collection_create", method: "collection.create", description: "Create a group collection/接龙. Requires owner confirmation.", parameters: OBJ({ groupId: S("Group id."), title: S("Title."), description: S("Optional description."), template: S("Entry template."), expireType: I("Expiry type."), expireAt: I("Expiry time ms."), maxParticipants: I("Max participants.") }, ["groupId", "title"]), write: true, preview: (a) => `创建接龙「${a.title}」` },
  { name: "app_collection_detail", method: "collection.detail", description: "Read a collection/接龙 detail.", parameters: OBJ({ collectionId: S("Collection id."), groupId: S("Optional group id.") }, ["collectionId"]) },
  { name: "app_collection_join", method: "collection.join", description: "Join a collection/接龙. Requires owner confirmation.", parameters: OBJ({ collectionId: S("Collection id."), groupId: S("Optional group id."), content: S("Entry content.") }, ["collectionId", "content"]), write: true, preview: (a) => `参与接龙 ${a.collectionId}\n${String(a.content || "").slice(0, 500)}` },
  { name: "app_collection_delete", method: "collection.delete", description: "Delete one collection entry. Requires owner confirmation.", parameters: OBJ({ collectionId: S("Collection id."), groupId: S("Optional group id.") }, ["collectionId"]), write: true, preview: (a) => `删除接龙条目 ${a.collectionId}` },
  { name: "app_collection_close", method: "collection.close", description: "Close a collection/接龙. Requires owner confirmation.", parameters: OBJ({ collectionId: S("Collection id."), groupId: S("Optional group id.") }, ["collectionId"]), write: true, preview: (a) => `关闭接龙 ${a.collectionId}` },

  // Organization / employees
  { name: "app_organization_root", method: "organization.root", description: "Read the root organization.", parameters: OBJ({}) },
  { name: "app_organization_get", method: "organization.get", description: "Read one organization node.", parameters: OBJ({ organizationId: S("Organization id.") }, ["organizationId"]) },
  { name: "app_organization_list", method: "organization.list", description: "Read multiple organization nodes by id.", parameters: OBJ({ organizationIds: A("Organization ids.") }, ["organizationIds"]) },
  { name: "app_organization_batch_employees", method: "organization.batchEmployees", description: "Read employees for multiple organization nodes.", parameters: OBJ({ organizationIds: A("Organization ids.") }, ["organizationIds"]) },
  { name: "app_organization_employees", method: "organization.employees", description: "List employees directly under an organization.", parameters: OBJ({ organizationId: S("Organization id.") }, ["organizationId"]) },
  { name: "app_organization_relationship", method: "organization.relationship", description: "Read an employee's organization relationship.", parameters: OBJ({ employeeId: S("Employee id.") }, ["employeeId"]) },
  { name: "app_organization_search_employee", method: "organization.searchEmployee", description: "Search employees in an organization.", parameters: OBJ({ organizationId: S("Optional organization id; defaults to root."), keyword: S("Search keyword.") }, ["keyword"]) },
  { name: "app_employee_get", method: "employee.get", description: "Read one employee profile.", parameters: OBJ({ employeeId: S("Employee id.") }, ["employeeId"]) },
  { name: "app_employee_list", method: "employee.list", description: "Read multiple employee profiles.", parameters: OBJ({ employeeIds: A("Employee ids.") }, ["employeeIds"]) },

  // Account profile
  { name: "app_change_name", method: "changeName", description: "Change the current Wildfire account display name. Requires owner confirmation.", parameters: OBJ({ newName: S("New display name.") }, ["newName"]), write: true, preview: (a) => `修改当前账号名称为「${a.newName}」` },
];

export function registerAppTools(api: any): void {
  if (!bridge()) {
    api.logger?.info?.("[wildfire] app service tools unavailable (WF_IM_BRIDGE_URL/TOKEN missing)");
    return;
  }
  let tools: any;
  try { tools = api.ctx?.get?.("tools"); } catch { tools = undefined; }
  if (!tools?.register) return;

  for (const def of DEFS) {
    const execute = async (args: any, exec: any) => {
      const values = args && typeof args === "object" ? args : {};
      if (def.write) {
        requireWriteTurn(api, exec, def.name);
        const preview = def.preview ? def.preview(values) : `${def.name}\n${JSON.stringify(values).slice(0, 500)}`;
        await confirmWriteAction(api, exec, def.name, preview);
      } else {
        requireOwnerTurn(api, exec, def.name);
        markReadResultTainted(api, exec);
      }
      return await call(def.method, values);
    };
    tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: OUT,
      async execute(args: any, exec: any) {
        return execute(args, exec);
      },
    });
  }
  api.logger?.info?.(`[wildfire] application service tools registered (${DEFS.length})`);
}
