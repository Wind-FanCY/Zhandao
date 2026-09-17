import OpenAI from "openai";
import { z } from "zod";
import { MissingApiKey } from "./keywords.js";

/**
 * 把一条**速记**原文提炼成短检索查询。
 *
 * 为什么需要这一步（实测，49 篇库）：速记原文当查询，正确宿主连前 12 都进不去；
 * 而「undici 不读 http_proxy 代理」这八个字排第 1。问题不是跨语言、不是库太小，
 * 是原文里的填充词（「所以」「要么」「需要」……）把信号淹了——机械丢高频词做不到
 * 「识别出 undici 是强信号、"所以"不是」这种判断，只能靠模型。见 CLAUDE.md「归属链路的实现约束」。
 *
 * 形状照抄 `keywords.ts`（同一个目录是唯一知道用哪家模型服务商的地方，
 * DeepSeek、OpenAI 兼容接口、`response_format: json_object`、无严格 schema 故手动 zod 校验、
 * 官方文档明示可能返回空内容故重试一次）。
 *
 * 与 `generateChineseKeywords` 的关键差异：那里两次都空就返回空数组，
 * 让关键词缺失不拖垮收录；这里两次都空必须**抛错**——因为调用方（归属界面）
 * 需要把「提炼失败」和「提炼出一个空查询」区分开，不能静默退化成用原文搜
 * （那会产出三个看起来正常、实际全错的候选）。
 */

const MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

const DistillSchema = z.object({ query: z.string() });

export class QueryDistillFailed extends Error {}

/**
 * DeepSeek 的 JSON 模式硬性要求：prompt 里必须出现 "json" 字样，且给出格式示例。
 * 提炼规则见 CLAUDE.md：拉丁标识符原样保留，中文只留 2-4 个实词，丢填充词，输出尽量短。
 */
const SYSTEM_PROMPT = [
  "你在帮一个人把他随手写下的**速记**原文提炼成一句适合拿去检索个人知识库的短查询。",
  "速记原文常常夹杂中文推理句式和拉丁标识符（库名、函数名、环境变量名）。",
  "规则：",
  "1. 拉丁标识符（如 undici、http_proxy、res.flush、EnvHttpProxyAgent）原样保留，它们是最强信号，不要翻译、不要丢弃。",
  "2. 中文只保留 2 到 4 个能定位材料主题的实词，丢掉「所以」「要么」「需要」「全部」「那不是」「系统功能」这类填充词和推理连接词。",
  "3. 输出尽量短，不要输出完整句子，不要复述原文的因果结构。",
  "以 json 格式输出，只含一个字段 query。格式示例：",
  '输入：「compression 会累积输出，SSE 连接长期不结束，所以事件永远不到；要么禁压缩，要么每次 write 后 res.flush()」',
  '输出：{"query": "compression SSE res.flush 缓冲"}',
].join("\n");

export async function distillQuery(noteText: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKey("未设置 DEEPSEEK_API_KEY，请写入 code/.env");
  }

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  // 文档明示可能返回空内容，故重试一次；两次都空/形状不对就抛错——
  // 与 generateChineseKeywords 不同，这里不能静默返回空字符串糊过去。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 128,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: noteText },
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

    const result = DistillSchema.safeParse(parsed);
    if (!result.success) continue; // 形状不对（zod 拦住），再试一次

    const query = result.data.query.trim();
    if (query.length > 0) return query;
  }

  throw new QueryDistillFailed("模型两次都未能提炼出合法查询");
}
