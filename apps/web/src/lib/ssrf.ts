import net from "node:net";
import { lookup } from "node:dns/promises";
import { ApiException } from "@/lib/api";

/**
 * SSRF 防护 —— 用于任何"服务端按用户提供的 URL 去 fetch"的路径(网站采集存图 +
 * /assets/[id]/raw 代理)。阻断指向回环 / 私网 / 链路本地(含云元数据
 * 169.254.169.254)/ 唯一本地地址的请求,防止把内网/元数据服务的响应回传给调用方。
 *
 * 注:DNS 解析与随后的 fetch 之间存在理论上的重绑定窗口;此处在"落库"与"取流"
 * 两端都校验已显著收窄攻击面。彻底消除需把 fetch 钉到已解析 IP(后续可加固)。
 */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // 私网
    if (a === 127) return true; // 回环
    if (a === 169 && b === 254) return true; // 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::1" || a === "::") return true; // 回环 / 未指定
    if (a.startsWith("fe80")) return true; // 链路本地
    if (a.startsWith("fc") || a.startsWith("fd")) return true; // 唯一本地
    const m = a.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return isPrivateIp(m[1]!); // IPv4 映射
    return false;
  }
  return false;
}

/**
 * 校验一个 URL 可安全地由服务端去 fetch。data: URL 不触网,直接放行。
 * 非 http(s)、内网/本地主机、解析到内网 IP 的域名 → 抛 400。
 */
export async function assertSafePublicUrl(raw: string): Promise<void> {
  if (raw.startsWith("data:")) return;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiException(400, "非法的资源 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiException(400, "仅支持 http(s) 资源 URL");
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ApiException(400, "禁止访问内网/本地地址");
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ApiException(400, "禁止访问内网/本地地址");
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new ApiException(400, "无法解析资源主机");
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new ApiException(400, "资源主机解析到内网/本地地址,已拒绝");
  }
}

/**
 * 像 fetch 一样取资源,但手动跟随重定向并对**每一跳**(含初始 URL 与每个
 * 3xx Location)做 assertSafePublicUrl 校验。fetch 默认自动跟随 30x,攻击者可
 * 用一个公网 URL 302 跳到 169.254.169.254 等内网地址绕过仅校验初始 URL 的防护;
 * 这里逐跳校验后再放行,彻底堵住重定向型 SSRF。
 */
export async function safeFetch(
  url: string,
  maxRedirects = 4,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafePublicUrl(current);
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res; // 3xx 但无 Location,交给调用方
      current = new URL(loc, current).toString(); // 解析相对跳转,下轮再校验
      continue;
    }
    return res;
  }
  throw new ApiException(400, "重定向次数过多,已拒绝");
}
