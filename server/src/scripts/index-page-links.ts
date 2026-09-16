/**
 * 从**索引页**的原始 HTML 里枚举「同前缀」的 `.html` 链接（ADR-0010）。
 *
 * 只做「找出该展开哪些链接」这一步，不做判断——过滤规则是纯字符串的前缀 + 后缀匹配，
 * 不引入启发式。这与 ADR-0010 里「识别不做启发式，由本人决定何时展开」的立场一致：
 * 这里枚举出的只是候选，是否真的收录仍由 expand-index-page.ts 的调用者（本人）决定
 * 要不要跑这个脚本、以及跑完之后怎么处理失败清单。
 */
import { JSDOM } from "jsdom";

/**
 * 计算索引页 URL 的目录前缀：去掉最后一段文件名，只留到最后一个 `/`。
 *
 * 索引页多数是目录形式的 URL（如 `https://xiaolincoding.com/network/`），
 * 这种情况下前缀就是它自己；但也兼容传入具体文件（如 `.../network/index.html`）。
 */
function directoryPrefixOf(indexUrl: string): string {
  const u = new URL(indexUrl);
  const path = u.pathname;
  const dirPath = path.endsWith("/") ? path : path.slice(0, path.lastIndexOf("/") + 1);
  return `${u.origin}${dirPath}`;
}

/** 去掉 URL 的 fragment（`#` 之后的部分）。 */
function stripFragment(url: string): string {
  const idx = url.indexOf("#");
  return idx === -1 ? url : url.slice(0, idx);
}

/**
 * 枚举 HTML 里「同前缀」的 `.html` 链接。
 *
 * 规则：
 * - `href` 解析出的绝对 URL 必须以「索引页目录前缀」开头（排除站外链接、其他目录，
 *   例：索引页在 `/network/` 时排除 `/os/...`）
 * - 必须以 `.html` 结尾（排除 `assets/*.js` 一类的静态资源、纯锚点导航）
 * - 排除索引页自身
 * - 按 HTML 中首次出现的顺序去重（fragment 视为同一 URL）
 *
 * @param html 索引页原始 HTML
 * @param indexUrl 索引页 URL，同时用作解析相对链接的 base
 */
export function enumerateSameFolderLinks(html: string, indexUrl: string): string[] {
  const dom = new JSDOM(html);
  const anchors = Array.from(dom.window.document.querySelectorAll("a[href]"));

  const prefix = directoryPrefixOf(indexUrl);
  const selfUrl = stripFragment(new URL(indexUrl).href);

  const seen = new Set<string>();
  const links: string[] = [];

  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;

    let absolute: string;
    try {
      absolute = new URL(href, indexUrl).href;
    } catch {
      // 无法解析的 href（如 `javascript:void(0)`），不是链接，跳过
      continue;
    }

    const clean = stripFragment(absolute);

    if (clean === selfUrl) continue;
    if (!clean.startsWith(prefix)) continue;
    if (!clean.endsWith(".html")) continue;
    if (seen.has(clean)) continue;

    seen.add(clean);
    links.push(clean);
  }

  return links;
}
