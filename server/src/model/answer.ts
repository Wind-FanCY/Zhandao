import OpenAI from "openai";
import { MissingApiKey } from "./keywords.js";

/**
 * **问答**循环里唯一知道"跟哪家模型服务商说话"的地方——与 `keywords.ts` /
 * `distill-query.ts` / `extract-drills.ts` 同一职责分工，见 CLAUDE.md「技术路线」。
 *
 * 与那三个调用点的关键差异：那三个各自在函数内部拼好完整的 system + user 消息，
 * 一次调用只问一件事；这里的调用方（`qa/loop.ts`）攒着一整轮会越长越长的对话历史
 * （`PROTOCOL_PROMPT` 开头 + 之后每轮的 assistant/user 往返），`askOnce` 只负责原样
 * 转发这份历史、拿到模型这一轮的 raw content 字符串。**JSON 解析、形状校验、
 * "这段内容是不是一个合法动作"完全不归这里管**——那是 `qa/protocol.ts` 的职责。
 * 这条分工正是 CLAUDE.md 反复强调的"model/ 只知道用哪家服务商，不知道内容长什么样"
 * 的字面应用：`askOnce` 换成别的服务商时，`qa/protocol.ts` 一行不用动；反过来，
 * 协议从手搓 JSON 换成原生 `tool_calls` 时，这个文件也大概率不用动
 * （无非是 `messages` 之外多传一个 `tools` 参数）。
 *
 * `deepseek-flash` 是推理模型，`max_tokens` 是"推理 + 正文"的总预算——用 8192，
 * 与 `extract-drills.ts` 同一个数字、同一个理由：问答场景里单轮输出通常很短
 * （一个五选一的小 json），但推理过程本身可能不短，抬预算比再排一次"为什么又是
 * 空 content"的雷划算。
 */

const MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

export class AnswerCallFailed extends Error {}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * 把当前对话历史发给模型，拿到这一轮的 raw content 字符串。
 *
 * 文档明示可能返回空内容，故重试一次；两次都空则抛 `AnswerCallFailed`，消息里带上
 * `finish_reason` 和输出 token 数（照抄 `extract-drills.ts` 的 `whys[]` 写法）——
 * 空内容和"输出被 `max_tokens` 截断在半截"表现类似但成因不同，处置也不同，
 * 光一句"模型没返回内容"定位不到问题。
 *
 * **两次都空是真失败，不像 `generateChineseKeywords` 那样静默降级成空数组**：
 * 问答循环没有"一个合理的空结果"可以退回去——`qa/loop.ts` 拿到失败必须整体中断，
 * 不能假装模型说了什么。
 */
export async function askOnce(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKey("未设置 DEEPSEEK_API_KEY，请写入 code/.env");
  }

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  const whys: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 8192,
      response_format: { type: "json_object" },
      messages,
    });

    const choice = completion.choices[0];
    const finish = choice?.finish_reason ?? "?";
    const out = completion.usage?.completion_tokens ?? -1;
    const content = choice?.message?.content?.trim();

    if (content) {
      return content;
    }

    whys.push(`第${attempt}次: 空内容 (finish_reason=${finish}, 输出 ${out} tokens)`);
  }

  throw new AnswerCallFailed(`模型两次都未能返回内容——${whys.join("；")}`);
}
