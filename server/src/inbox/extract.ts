import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";

export type ExtractSuccess = {
  ok: true;
  /** Readability 清洗后的标题。不要用调用方传入的标题。 */
  title: string;
  /** 正文，Markdown 格式 */
  markdown: string;
  /** 纯文本字数，用于判断抽取是否可疑 */
  textLength: number;
  /** 最终 URL（跟随重定向后），已去掉 fragment */
  finalUrl: string;
};

export type ExtractFailure = {
  ok: false;
  reason: "not_html" | "http_error" | "network" | "timeout" | "no_content" | "too_short";
  detail: string;
};

export type ExtractResult = ExtractSuccess | ExtractFailure;

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MIN_TEXT_LENGTH = 200;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 从 Content-Type 头提取字符集。
 * 例如 "text/html; charset=UTF-8" 返回 "UTF-8"。
 */
function extractCharsetFromHeader(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = contentType.match(/charset\s*=\s*([^\s;]+)/i);
  return match?.[1]?.replace(/^["']|["']$/g, "") ?? undefined;
}

/**
 * 从 HTML 的 meta 标签推断字符集。
 * 支持 <meta charset> 和 <meta http-equiv="Content-Type" content="...">。
 * meta 优先级高于 Content-Type 头。
 */
function extractCharsetFromMeta(html: string): string | undefined {
  // <meta charset="UTF-8">
  const charsetMatch = html.match(/<meta\s+charset\s*=\s*["']?([^\s"'>]+)/i);
  if (charsetMatch) return charsetMatch[1];

  // <meta http-equiv="Content-Type" content="text/html; charset=...">
  const httpEquivMatch = html.match(
    /<meta\s+http-equiv\s*=\s*["']?content-type["']?\s+content\s*=\s*["']([^"']+)["']/i,
  );
  if (httpEquivMatch) {
    const content = httpEquivMatch[1];
    const charset = extractCharsetFromHeader(content);
    if (charset) return charset;
  }

  return undefined;
}

/**
 * 从 Content-Type 头和 HTML meta 标签推断正确的字符编码。
 * meta 标签优先级高于 Content-Type 头。
 * 只在前 2048 字节内查找 meta 标签，符合 HTML 规范。
 */
function detectEncoding(contentTypeHeader: string | undefined, sniffedHead: string): string {
  // 先尝试 meta（在文档开头），再试 header，最后默认 UTF-8
  const fromMeta = extractCharsetFromMeta(sniffedHead);
  if (fromMeta) return fromMeta;

  const fromHeader = extractCharsetFromHeader(contentTypeHeader);
  if (fromHeader) return fromHeader;

  return "UTF-8";
}

/**
 * 将 ArrayBuffer 按指定编码解码成字符串。
 * TextDecoder 支持的编码见 https://encoding.spec.whatwg.org/
 */
function decodeBuffer(buffer: ArrayBuffer, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    // 如果不支持该编码，回退到 UTF-8
    return new TextDecoder("UTF-8").decode(buffer);
  }
}

/**
 * 从 HTML 中提取纯文本字数。
 */
function countTextLength(text: string): number {
  // 去掉空白符后计算长度，更准确地反映实际内容量
  return text.replace(/\s+/g, "").length;
}

/**
 * 将 finalUrl 中的 fragment 移除。
 */
function removeFragment(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

/**
 * 从 URL 抽取文章正文和元数据。
 *
 * @param url 目标页面 URL
 * @param options.timeoutMs 超时时长，默认 15000ms
 * @param options.minTextLength 最少纯文本字数，默认 200，短于此返回 "too_short"
 */
export async function extractArticle(
  url: string,
  options?: { timeoutMs?: number; minTextLength?: number },
): Promise<ExtractResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minTextLength = options?.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": USER_AGENT },
      });
    } catch (err) {
      const errName = (err as Error)?.name ?? "";
      // AbortSignal.timeout() 抛出 DOMException("TimeoutError")，而其他 abort 抛出 "AbortError"
      if (errName === "TimeoutError") {
        return { ok: false, reason: "timeout", detail: `Request timeout after ${timeoutMs}ms` };
      }
      return {
        ok: false,
        reason: "network",
        detail: `Network error: ${(err as Error).message}`,
      };
    }

    // 处理 HTTP 错误
    if (!response.ok) {
      return {
        ok: false,
        reason: "http_error",
        detail: `HTTP ${response.status}`,
      };
    }

    // 检查 Content-Type，拒绝 PDF 和非 HTML/XHTML
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/pdf")) {
      return { ok: false, reason: "not_html", detail: "Content-Type is application/pdf" };
    }
    const isHtml =
      contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    if (!isHtml) {
      return {
        ok: false,
        reason: "not_html",
        detail: `Content-Type is ${contentType || "unknown"}`,
      };
    }

    // 获取字节数据，但只嗅探前 2048 字节来检测编码
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (err) {
      return {
        ok: false,
        reason: "network",
        detail: `Failed to read response body: ${(err as Error).message}`,
      };
    }

    // 只解码前 2048 字节用于编码检测（meta 标签必须在文档开头）
    const sniffedSize = Math.min(2048, buffer.byteLength);
    const sniffedBuffer = buffer.slice(0, sniffedSize);
    const sniffedHead = decodeBuffer(sniffedBuffer, "UTF-8");
    const encoding = detectEncoding(contentType, sniffedHead);
    const html = decodeBuffer(buffer, encoding);

    // 用 jsdom 解析并提交给 Readability
    // 使用最终 URL（response.url）作为 base，以便相对链接正确解析（特别是在重定向场景）
    const finalUrlBase = removeFragment(response.url || url);
    let article: ReturnType<Readability["parse"]>;
    try {
      const dom = new JSDOM(html, { url: finalUrlBase });
      const reader = new Readability(dom.window.document);
      article = reader.parse();
    } catch (err) {
      return {
        ok: false,
        reason: "no_content",
        detail: `Failed to parse HTML: ${(err as Error).message}`,
      };
    }

    if (!article) {
      return { ok: false, reason: "no_content", detail: "Readability returned null" };
    }

    // 用 turndown 转成 Markdown
    let markdown: string;
    try {
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
      });
      const content = article.content || "";
      markdown = turndown.turndown(content);
    } catch (err) {
      return {
        ok: false,
        reason: "no_content",
        detail: `Failed to convert to Markdown: ${(err as Error).message}`,
      };
    }

    // 检查正文长度
    const textLength = countTextLength(article.textContent || "");
    if (textLength < minTextLength) {
      return {
        ok: false,
        reason: "too_short",
        detail: `Text length ${textLength} < ${minTextLength}`,
      };
    }

    // 最终标题，空字符串或全空白时回退到 finalUrl
    let title = (article.title || "").trim();
    if (!title) {
      title = finalUrlBase;
    }

    return {
      ok: true,
      title,
      markdown,
      textLength,
      finalUrl: finalUrlBase,
    };
  } catch (err) {
    // 捕获所有未预期的异常，防止抛给调用方
    return {
      ok: false,
      reason: "no_content",
      detail: `Unexpected error: ${(err as Error).message}`,
    };
  }
}
