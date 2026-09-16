import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * 本文件是**唯一**知道「我们在用 Claude」的地方。
 *
 * 为什么不造 `interface ModelProvider`：现在只有一个调用点，基于一个调用点设计的接口
 * 形状大概率要重做——将来的查询改写要不要流式？出题要不要 tool use？都还不知道。
 * 换服务商（比如毕业后换 DeepSeek）就改这个文件的函数体，调用方一行不动。
 * 等调用点长到三个以上、能看出共同形状时，再把 provider 层抽出来。
 */

const KeywordsSchema = z.object({
  keywords: z
    .array(z.string())
    .describe("中文检索关键词，5 到 10 个，按重要性降序"),
});

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
 * 给一份纯英文**材料**生成中文检索关键词。
 *
 * 注意 prompt 的取向：要的**不是**「把标题译成中文」，而是
 * 「一个中文用户想找这篇内容时会敲什么词」——因为这些关键词的唯一用途是进检索索引，
 * 补上中文查询命中纯英文材料时的那个 0%（见 CLAUDE.md 的实测基线）。
 */
export async function generateChineseKeywords(
  title: string,
  markdown: string,
): Promise<string[]> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new MissingApiKey("未设置 ANTHROPIC_API_KEY，请写入 code/.env");
  }

  // 组织级（未绑定 workspace）的 API key 必须带 anthropic-workspace-id 头，
  // 否则 messages 接口返回 400。绑定到 workspace 的 key 不需要这个头。
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(
    workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {},
  );

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    // 关键词提取不是推理任务，低 effort 省的是延迟不是钱
    output_config: { effort: "low", format: zodOutputFormat(KeywordsSchema) },
    system:
      "你在为一个中文使用者的个人知识库建检索索引。给定一篇英文技术材料，" +
      "输出这个人日后想找回这篇内容时最可能敲进搜索框的中文词。" +
      "要贴近口语和实际提问方式，不要逐字翻译标题；" +
      "专有名词（API 名、库名）保留英文原形。",
    messages: [
      {
        role: "user",
        content: `标题：${title}\n\n正文：\n${markdown}`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) return [];
  // 去重、去空白、保序
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of parsed.keywords) {
    const t = k.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
