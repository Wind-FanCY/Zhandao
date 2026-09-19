import OpenAI from "openai";
import { z } from "zod";
import { MissingApiKey } from "./keywords.js";

/**
 * 从一份**材料**正文的候选行里**提取**（不是生成）现成的问题，供**预练**使用。见 ADR-0011
 * 与 CLAUDE.md「预练链路的实现约束」。
 *
 * 为什么不能用机械规则：实测纯正则/标题匹配在最该被预练的三篇材料上合计只提出 3 道题
 * （Promise 面试题的标题只是「题目一」这类编号标签，防抖/深拷贝篇的标题是名词短语），
 * 绕过去的唯一办法是写站点特定正则——与 CLAUDE.md 为 `unwrapCodeWrappers` 明令禁止的
 * 「给某个站点生成器打补丁」同形。所以改用模型判断「哪些候选值得练、问题怎么问」。
 *
 * **2026-09-19 改法，别喂全文**：`deepseek-flash` 是推理模型，`max_tokens` 是「推理 + 正文」
 * 的总预算，而推理会先把它花光，且随输入长度增长。实测喂全文时：
 *
 *   4.1 TCP 三次握手（41246 字符正文）
 *     prompt_tokens        20608
 *     completion_tokens     8192   其中 reasoning_tokens 8192（100%）
 *     content 长度             0
 *     reasoning_content    16405 字符
 *     finish_reason        length
 *
 * 抬 `max_tokens` 治不了——已经从 4096 抬到 8192，`4.1` 和「45 道 Promise 面试题」那篇
 * 仍然 0 字节输出。而且它非确定性：中等大小材料同一篇跑两次，一次成功一次失败。
 *
 * 现在只喂 `drills/anchor.ts` 的 `collectCandidateLines` 机械枚举出的标题行/整行加粗行——
 * 全库实测最多一篇 65 行，典型 20–50 行，输入从两万 token 级降到千把。
 * 这也是「提取而非生成」这条不变量的关键一环：模型现在**只能**从候选行号里挑，
 * 连编一道没有锚点的题的物理可能性都没有——不变量从「模型转录 anchor、事后核对能否定位」
 * 变成「模型只能选行号、由构造保证」，`buildDrills` 只需按行号查表，不再需要模糊匹配。
 *
 * 形状照抄 `distill-query.ts`（同一目录是唯一知道用哪家模型服务商的地方）：
 * DeepSeek、OpenAI 兼容接口、`response_format: json_object`、无严格 schema 故手动 zod 校验、
 * 官方文档明示可能返回空内容故重试一次。
 *
 * 与 `distillQuery` 的关键差异：**空数组是合法返回值，不是失败**——很多材料本来就没有
 * 现成的问题（性能优化篇 27 个标题里 24 个是名词短语，如「图片压缩」「精灵图」，
 * 见 ADR-0011），提取失败是指
 * 「模型两次都没给出合法 JSON」，不是「给出了空列表」。
 */

const MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

const DrillsSchema = z.object({
  drills: z.array(z.object({ line: z.number().int(), question: z.string() })),
});

export class DrillExtractFailed extends Error {}

/**
 * DeepSeek 的 JSON 模式硬性要求：prompt 里必须出现 "json" 字样，且给出格式示例。
 */
export const SYSTEM_PROMPT = [
  "下面是一篇技术文章里的全部标题行和加粗行，每行前面是它在原文里的行号。",
  "请从中挑出适合拿来做面试预练的题，并为每一条写出问题。",
  "1. 只能从给出的行里挑，line 必须是上面出现过的行号，不要编造行号。",
  "2. 那一行本身就是问句时，question 用那个问句（去掉编号和链接标记）。",
  "3. 那一行是编号标签（如「题目一」）或名词短语（如「防抖函数」「精灵图」）时，",
  "   question 写成一句自然的面试问法（如「下面这段代码输出什么？」「手写一个防抖函数」）。",
  "4. 跳过「前言」「小结」「参考资料」「作者介绍」这类不构成题目的行。",
  "5. 一道题都挑不出来就返回空数组。",
  "以 json 格式输出，只含一个字段 drills。格式示例：",
  '{"drills": [{"line": 12, "question": "GET 和 POST 有什么区别？"}]}',
].join("\n");

/** 把候选行拼成喂给模型的 user message：每行 `L<line>: <text>`。 */
function formatCandidates(candidates: { line: number; text: string }[]): string {
  return candidates.map((c) => `L${c.line}: ${c.text}`).join("\n");
}

export async function extractDrills(
  candidates: { line: number; text: string }[],
): Promise<{ line: number; question: string }[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKey("未设置 DEEPSEEK_API_KEY，请写入 code/.env");
  }

  // 候选集本身为空（材料没有任何标题/加粗行）——不必调模型，空数组是合法结果。
  if (candidates.length === 0) {
    return [];
  }

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  const userMessage = formatCandidates(candidates);

  // 文档明示可能返回空内容，故重试一次；两次都空/形状不对才抛错——
  // 空数组本身不走这条重试路径，见下面 `return result.data.drills`。
  // 每次失败都记下「为什么」。空消息是这个项目反复吃过亏的失效形态：
  // 「模型两次都失败」这句话不能定位问题，而 finish_reason=length（输出被 max_tokens
  // 截断，JSON 截在半截）与 finish_reason=stop 但形状不对，处置完全不同。
  const whys: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      // 输出比改动前短得多（只挑行号 + 短问题，不再要求逐字转录整行 anchor），
      // 但 8192 仍然留着：推理模型的推理预算与输出共享同一个 max_tokens，
      // 候选行喂进去后输入已经降到千把 token，实测不会再撞到这个上限，
      // 留足余量比日后再排一次「为什么又是空 content」的雷划算。
      max_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    const choice = completion.choices[0];
    const finish = choice?.finish_reason ?? "?";
    const out = completion.usage?.completion_tokens ?? -1;
    const content = choice?.message?.content?.trim();
    if (!content) {
      whys.push(`第${attempt}次: 空内容 (finish_reason=${finish})`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // finish_reason=length 时几乎必然是这一条：输出到上限被切断，JSON 缺右括号
      whys.push(`第${attempt}次: JSON 解析失败 (finish_reason=${finish}, 输出 ${out} tokens, 长度 ${content.length})`);
      continue;
    }

    const result = DrillsSchema.safeParse(parsed);
    if (!result.success) {
      whys.push(`第${attempt}次: 形状不对 (finish_reason=${finish}, ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message})`);
      continue;
    }

    // 空数组是合法结果——不是所有材料都有现成的问题，不应被当成失败重试
    return result.data.drills;
  }

  throw new DrillExtractFailed(`模型两次都未能提取出合法的练题列表——${whys.join("；")}`);
}
