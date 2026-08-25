#!/usr/bin/env node
/**
 * 构建期校验：确认本地解析到的 @wildfirechat/robot-gateway-client-sdk
 * 提供插件运行时依赖的全部方法。
 *
 * 背景：插件的状态/进度推送依赖 RobotServiceClient.updateConversationUserSetting，
 * 该方法尚未发布到 npm（当前 package.json 用 file:../client.js 引用本仓库 SDK）。
 * 若有人把依赖换回 npm 版（<1.0.6）或 file: 路径解析失败，插件会在运行时
 * 静默失去状态推送。此脚本在 build/pack 前拦截，避免把残缺的包发布出去。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED_METHODS = [
  "updateConversationUserSetting",
  "updateMessage",
  "sendMessage",
  "getProfile",
  "getGroupInfo",
  "getGroupMembers",
  "createGroup",
  "dismissGroup",
  "modifyGroupInfo",
  "addGroupMembers",
  "kickoffGroupMembers",
  "muteGroupMember",
  "uploadFile",
];

let pkgPath;
try {
  pkgPath = require.resolve("@wildfirechat/robot-gateway-client-sdk/package.json");
} catch (err) {
  console.error(
    "[check-sdk] FAILED: cannot resolve @wildfirechat/robot-gateway-client-sdk. " +
      "The plugin currently depends on the unpublished SDK via file:../client.js — " +
      "install it locally (npm install) before building/packing."
  );
  process.exit(1);
}

const pkg = require(pkgPath);
const entry = path.join(path.dirname(pkgPath), pkg.main ?? "src/index.js");
let mod;
try {
  mod = await import(entry);
} catch (err) {
  console.error(`[check-sdk] FAILED: cannot import SDK entry ${entry}: ${err.message}`);
  process.exit(1);
}

const Client = mod?.RobotServiceClient ?? mod?.default?.RobotServiceClient;
if (!Client || typeof Client !== "function") {
  console.error("[check-sdk] FAILED: RobotServiceClient not exported from the SDK entry");
  process.exit(1);
}

const missing = REQUIRED_METHODS.filter(
  (m) => typeof Client.prototype[m] !== "function"
);
if (missing.length > 0) {
  console.error(
    `[check-sdk] FAILED: SDK ${pkg.version} (${pkgPath}) is missing methods the plugin needs:`
  );
  for (const m of missing) console.error(`  - ${m}`);
  console.error(
    "[check-sdk] The plugin requires the unpublished SDK features (updateConversationUserSetting). " +
      "Publish SDK >= 1.0.6 first, then switch package.json back to a version dependency."
  );
  process.exit(1);
}

console.log(
  `[check-sdk] OK: SDK ${pkg.version} (${pkgPath}) provides all ${REQUIRED_METHODS.length} required methods`
);
