/**
 * 入站媒体 URL 安全策略。
 *
 * 插件收到 IM 消息里的 mediaUrl 后要去下载/转写；该 URL 来自消息 payload，
 * 任意用户都可以构造（不一定是野火官方客户端上传的结果），因此必须防 SSRF：
 *  - 只允许 http/https，拒绝内嵌凭据；
 *  - 可配置主机白名单（支持 *.example.com）；
 *  - DNS 解析后校验所有 A/AAAA 地址：回环、链路本地（含云 metadata）、保留/组播
 *    地址始终拒绝；RFC1918/CGNAT/ULA 由 allowPrivateHosts 控制（默认允许，
 *    兼容私有化部署）；
 *  - 重定向手动跟随，每跳都重新校验。
 *
 * 已知残留风险：DNS 校验与实际连接之间仍可能被 rebinding（校验后重新解析到
 * 别的 IP）。第一版按“解析后校验 + 重定向校验”实现；需要更严格时可在连接层
 * 固定校验过的 IP。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export type MediaUrlRejectReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "url_too_long"
  | "host_not_allowed"
  | "resolve_failed"
  | "blocked_loopback"
  | "blocked_link_local"
  | "blocked_metadata"
  | "blocked_private"
  | "blocked_reserved"
  | "redirect_limit"
  | "redirect_invalid";

export class MediaUrlError extends Error {
  readonly code: MediaUrlRejectReason;
  readonly host?: string;
  constructor(code: MediaUrlRejectReason, message: string, host?: string) {
    super(message);
    this.name = "MediaUrlError";
    this.code = code;
    this.host = host;
  }
}

export interface MediaUrlPolicy {
  /** 允许的主机：精确域名/IP，或 *.example.com（只匹配子域）；空 = 不限制主机。 */
  allowedHosts?: string[];
  /** 是否允许 RFC1918/CGNAT/ULA 内网地址。默认 true（兼容私有化部署）。 */
  allowPrivateHosts?: boolean;
  /** 最多跟随多少次重定向，默认 3。 */
  maxRedirects?: number;
}

export interface ResolvedMediaUrlPolicy {
  allowedHosts: string[];
  allowPrivateHosts: boolean;
  maxRedirects: number;
}

export type MediaResolver = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

export interface MediaPolicyOptions {
  /** 测试用：替换 DNS 解析。 */
  resolve?: MediaResolver;
  /** 测试用：替换 fetch。 */
  fetchImpl?: typeof fetch;
}

const MAX_URL_LENGTH = 2048;

/** 已知的云 metadata 地址（即使 allowPrivateHosts=true 也拒绝）。 */
const ALWAYS_BLOCKED_ADDRESSES = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
]);

export function normalizePolicy(policy?: MediaUrlPolicy): ResolvedMediaUrlPolicy {
  const hosts = Array.isArray(policy?.allowedHosts)
    ? policy.allowedHosts
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
        .filter(Boolean)
    : [];
  const maxRedirects = Number.isInteger(policy?.maxRedirects) && (policy?.maxRedirects ?? 0) >= 0
    ? Number(policy?.maxRedirects)
    : 3;
  return {
    allowedHosts: hosts,
    allowPrivateHosts: policy?.allowPrivateHosts !== false,
    maxRedirects,
  };
}

/** 主机是否命中白名单（空白名单 = 不限制）。 */
export function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!allowedHosts.length) return true;
  return allowedHosts.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      return host.length > suffix.length && host.endsWith(suffix);
    }
    return host === entry;
  });
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

function isIpv4Private(octets: number[]): boolean {
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127); // CGNAT 也按内网处理
}

function isIpv4ReservedOrSpecial(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;     // 198.18.0.0/15
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && octets[2] === 113) return true;  // 203.0.113.0/24
  if (a >= 224 && a <= 239) return true;           // multicast
  if (a >= 240) return true;                       // reserved
  return false;
}

function classifyIpv4(address: string): "public" | "loopback" | "link-local" | "private" | "reserved" {
  const octets = parseIpv4(address);
  if (!octets) return "reserved";
  const [a, b] = octets;
  if (ALWAYS_BLOCKED_ADDRESSES.has(address)) return "reserved"; // 由上层报 metadata
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (isIpv4Private(octets)) return "private";
  if (isIpv4ReservedOrSpecial(octets)) return "reserved";
  return "public";
}

function normalizeIpv6(address: string): string {
  // 去掉 zone id（fe80::1%en0）
  return address.split("%")[0].toLowerCase();
}

function ipv4FromMappedIpv6(address: string): string | null {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

function classifyIpv6(rawAddress: string): "public" | "loopback" | "link-local" | "private" | "reserved" {
  const address = normalizeIpv6(rawAddress);
  if (ALWAYS_BLOCKED_ADDRESSES.has(address)) return "reserved";
  const mapped = ipv4FromMappedIpv6(address);
  if (mapped) {
    const cls = classifyIpv4(mapped);
    if (cls === "public") return "public";
    return cls;
  }
  if (address === "::1") return "loopback";
  if (address === "::") return "reserved";
  if (address.startsWith("fe80:") || address.startsWith("febf:")) return "link-local";
  if (address.startsWith("fc") || address.startsWith("fd")) return "private";
  if (address.startsWith("ff")) return "reserved"; // multicast
  if (address.startsWith("2001:db8:")) return "reserved";
  if (address.startsWith("::ffff:")) return "reserved"; // 无法解析的 mapped 形式
  return "public";
}

/** 判断地址是否被策略阻止；返回 null 表示放行。 */
export function classifyBlockedAddress(address: string): MediaUrlRejectReason | null {
  const cls = net.isIP(address) === 6 ? classifyIpv6(address) : classifyIpv4(address);
  if (cls === "loopback") return "blocked_loopback";
  if (cls === "link-local") return "blocked_link_local";
  if (cls === "reserved") return ALWAYS_BLOCKED_ADDRESSES.has(normalizeIpv6(address)) ? "blocked_metadata" : "blocked_reserved";
  if (cls === "private") return "blocked_private";
  return null;
}

async function defaultResolve(hostname: string): Promise<Array<{ address: string; family?: number }>> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows;
}

/**
 * 校验一个媒体 URL；成功返回规范化后的 URL，失败抛 MediaUrlError。
 * 每个重定向目标都应重新调用一次。
 */
export async function validateMediaUrl(
  rawUrl: string,
  policy?: MediaUrlPolicy,
  options: MediaPolicyOptions = {}
): Promise<URL> {
  const resolved = normalizePolicy(policy);
  const text = String(rawUrl ?? "").trim();
  if (!text || text.length > MAX_URL_LENGTH) {
    throw new MediaUrlError(text.length > MAX_URL_LENGTH ? "url_too_long" : "invalid_url",
      text.length > MAX_URL_LENGTH ? "media URL is too long" : "media URL is empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new MediaUrlError("invalid_url", "media URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaUrlError("unsupported_scheme", `unsupported media URL scheme: ${parsed.protocol}//`);
  }
  if (parsed.username || parsed.password) {
    throw new MediaUrlError("credentials_not_allowed", "media URL must not embed credentials", parsed.hostname);
  }
  // URL.hostname 对 IPv6 字面量会带方括号（[::1]）；去掉后再做 IP/白名单判断。
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!hostname) throw new MediaUrlError("invalid_url", "media URL has no host");
  if (!hostAllowed(hostname, resolved.allowedHosts)) {
    throw new MediaUrlError("host_not_allowed", `media host is not allowed: ${hostname}`, hostname);
  }

  const literal = net.isIP(hostname);
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await (options.resolve ?? defaultResolve)(hostname).catch((err: any) => {
        throw new MediaUrlError("resolve_failed", `media host resolution failed: ${hostname}: ${String(err?.message ?? err)}`, hostname);
      });
  if (!addresses.length) {
    throw new MediaUrlError("resolve_failed", `media host has no address: ${hostname}`, hostname);
  }
  for (const row of addresses) {
    const address = String(row?.address ?? "");
    const blocked = classifyBlockedAddress(address);
    if (!blocked) continue;
    if (blocked === "blocked_private" && resolved.allowPrivateHosts) continue;
    // metadata 永远是拒绝的（即使允许内网）
    if (blocked === "blocked_metadata") {
      throw new MediaUrlError("blocked_metadata", `media host points to a metadata address: ${hostname} (${address})`, hostname);
    }
    throw new MediaUrlError(blocked, `media host address is blocked: ${hostname} (${address})`, hostname);
  }
  return parsed;
}

export interface FetchMediaOptions extends MediaPolicyOptions {
  signal?: AbortSignal;
}

/**
 * 按策略抓取媒体：手动跟随重定向，每一跳都做 URL/主机/IP 校验。
 * 返回最终（非重定向）响应；调用方负责读取 body / 限制大小。
 */
export async function fetchMediaWithPolicy(
  rawUrl: string,
  policy?: MediaUrlPolicy,
  options: FetchMediaOptions = {}
): Promise<Response> {
  const resolved = normalizePolicy(policy);
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = await validateMediaUrl(rawUrl, resolved, options);
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (!location) {
        throw new MediaUrlError("redirect_invalid", "media redirect has no location", current.hostname);
      }
      if (hop >= resolved.maxRedirects) {
        throw new MediaUrlError("redirect_limit", `media redirect exceeds ${resolved.maxRedirects} hop(s)`, current.hostname);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new MediaUrlError("redirect_invalid", "media redirect location is invalid", current.hostname);
      }
      current = await validateMediaUrl(next.toString(), resolved, options);
      continue;
    }
    return response;
  }
}
