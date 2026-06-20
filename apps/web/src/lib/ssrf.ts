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
/** 把 IPv6 字面量展开为 8 个 16bit 段(处理 `::` 压缩与内嵌 IPv4)。失败返回 null。 */
function ipv6ToHextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // 内嵌点分 IPv4(如 ::ffff:127.0.0.1)→ 把尾部转成两个 hex 段
  const v4 = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4) {
    const parts = v4[2]!.split(".").map(Number);
    if (parts.some((n) => n > 255)) return null;
    const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
    const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
    s = `${v4[1]}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || "0", 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

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
    const h = ipv6ToHextets(ip);
    if (!h) return true; // 解析不了 → 当作不安全
    if (h.every((x) => x === 0)) return true; // :: 未指定
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 回环
    if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    // IPv4-mapped(::ffff:a.b.c.d,含十六进制写法 ::ffff:7f00:1)与已弃用的
    // IPv4-compatible(::a.b.c.d)→ 还原 IPv4 再判私网。
    const mapped =
      h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;
    if (mapped && (h[5] === 0xffff || (h[5] === 0 && (h[6]! !== 0 || h[7]! !== 0)))) {
      const v4 = `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
      return isPrivateIp(v4);
    }
    return false;
  }
  return false;
}

/**
 * 校验一个 URL 可安全地由服务端去 fetch。data: URL 不触网,直接放行。
 * 非 http(s)、内网/本地主机、解析到内网 IP 的域名 → 抛 400。
 */
export async function assertSafePublicUrl(raw: string): Promise<void> {
  // data: URL 不触网,但 /assets/[id]/raw 会按其 content-type 同源回放——只放行
  // 图片 data: URL,否则 data:text/html 等会变成同源 HTML/JS(存储型 XSS)。
  if (raw.startsWith("data:")) {
    // 仅放行光栅图 data: URL;svg 是活动内容(同源可执行脚本),排除。
    if (!/^data:image\//i.test(raw) || /^data:image\/svg/i.test(raw)) {
      throw new ApiException(400, "仅允许光栅图片类型的 data: URL");
    }
    return;
  }
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
