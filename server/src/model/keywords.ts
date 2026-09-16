import OpenAI from "openai";
import { z } from "zod";

/**
 * 本文件是**唯一**知道用哪家模型服务商的地方。当前：DeepSeek。
 *
 * 为什么不造 `interface ModelProvider`：目前只有一个调用点，基于一个调用点设计的
 * 接口形状大概率要重做——将来的查询改写要不要流式？出题要不要 tool use？都还不知道。
 * 换服务商就改这个文件的函数体，调用方一行不动。这条设计刚被实战检验过一次：
 * 原本用 Claude，因学校组织账号的 key 无法绑定 workspace（调任何接口都 400）而换成
 * DeepSeek——改动范围就是这一个文件。
 *
 * DeepSeek 与 Claude 的三处实质差异（依官方文档，不是照搬 OpenAI 的写法）：
 *   1. 走 OpenAI 兼容接口，`baseURL: https://api.deepseek.com`
 *   2. **没有严格 JSON Schema**，只有 `response_format: {type:"json_object"}`。
 *      所以 schema 校验必须我们自己做——下面用 zod 兜。
 *   3. 文档明示「API 可能偶尔返回空内容」。这是它自己写下的坑，必须处理。
 */

const MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

const KeywordsSchema = z.object({ keywords: z.array(z.string()) });

/** 中文字符占比。低于此阈值视为「纯英文材料」，需要补中文关键词。 */
const CJK_RATIO_THRESHOLD = 0.05;

export function cjkRatio(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  return cjk + latin === 0 ? 0 : cjk / (cjk + latin);
}

export function needsChineseKeywords(text: string): boolean {
  return cjkRatio(text) < CJK_RATIO_THRESHOLD;
}

export class MissingApiKey extends Error {}

/**
 * DeepSeek 的 JSON 模式有两条硬性要求（文档原文）：prompt 里必须出现 "json" 字样，
 * 且必须给出期望格式的示例。缺任何一条都可能拿不到合法 JSON。
 */
const SYSTEM_PROMPT = [
  "你在为一个中文使用者的个人知识库建检索索引。",
  "给定一篇英文技术材料，输出这个人日后想找回这篇内容时最可能敲进搜索框的中文词。",
  "要贴近口语和实际提问方式，不要逐字翻译标题；专有名词（API 名、库名）保留英文原形。",
  "以 json 格式输出，5 到 10 个关键词，按重要性降序。格式示例：",
  '{"keywords": ["服务端推送", "EventSource", "事件流格式", "断线重连"]}',
].join("\n");

export async function generateChineseKeywords(
  title: string,
  markdown: string,
): Promise<string[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKey("未设置 DEEPSEEK_API_KEY，请写入 code/.env");
  }

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  // 文档明示可能返回空内容，故重试一次；两次都空就认了，返回空数组而不抛异常——
  // 关键词缺失只会让检索差一点，不该让整条收录流程失败。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `标题：${title}\n\n正文：\n${markdown}` },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue; // 不是合法 JSON，再试一次
    }
    const result = KeywordsSchema.safeParse(parsed);
    if (!result.success) continue;

    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of result.data.keywords) {
      const t = k.trim();
      if (t.length === 0 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    if (out.length > 0) return out;
  }
  return [];
}
