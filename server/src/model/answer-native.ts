import OpenAI from "openai";
import { z } from "zod";
import { MissingApiKey } from "./keywords.js";

/**
 * **问答**循环的第二条协议实现——用 DeepSeek 原生 `tools` / `tool_calls`，
 * 与 `answer.ts`（手搓 JSON 协议）并排存在，供 `scripts/ask-compare.ts` 做对照实验。
 *
 * 结构照抄 `answer.ts`：同一个 `MODEL` / `BASE_URL`、同一个"重试一次、两次都空就抛错"的
 * 节奏、同样把 `finish_reason` 和 token 数塞进失败消息。**唯一的实质差异**：
 * 不设 `response_format: json_object`——原生工具调用不需要用 prompt 逼出 json 格式，
 * 格式由 `tools` 参数本身保证；相应地，"空结果"的判定也从"content 是空的"
 * 扩成"content 和 tool_calls 都是空的"，因为 `finish_reason: "tool_calls"` 时
 * `content` 天然就是 `null`——那不是失败，是这一轮选择了调用工具。
 *
 * **`messages` / `toolSchemas` 参数类型是 `unknown[]`，不是 SDK 的具体类型**：调用方
 * （`qa/loop-native.ts`）不应该依赖 `model/` 内部用的是哪个 SDK 的消息形状，
 * 那是"model/ 是唯一知道用哪家服务商"这条分工的延伸——协议层拼出的是"OpenAI 兼容
 * 消息的字面形状"，但那只是巧合（DeepSeek 走 OpenAI 兼容接口），不是契约。
 * 所以这里必须把 `unknown[]` **校验**成 SDK 能接受的形状，而不是 `as` 断言过去——
 * 形状是嵌套的（`assistant.tool_calls[]`、`tool.tool_call_id` 等判别字段），
 * 按 CLAUDE.md「形状嵌套且来源最不可信的用 zod」的权宜界线，这里用 zod。
 */

const MODEL = "deepseek-flash";
const BASE_URL = "https://api.deepseek.com";

export interface NativeToolCall {
  id: string;
  name: string;
  argsRaw: string;
}

export interface NativeTurn {
  content: string | null;
  toolCalls: NativeToolCall[];
}

export class NativeCallFailed extends Error {}

// ---- 把 unknown[] 校验 + 收窄成 OpenAI SDK 能接受的具体类型，不用 `as` ----

const NativeToolCallWireSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

/**
 * 只认四种角色，形状对应 `qa/loop-native.ts` 实际会拼出的消息：
 * system/user 是纯文本；assistant 可能带 `tool_calls`（此时 `content` 常是 `null`）；
 * tool 是工具执行结果，必须带 `tool_call_id`——**这是原生协议里唯一新增的角色**，
 * 手搓协议（`qa/loop.ts`）全程只有 system/user/assistant 三种。
 */
const NativeMessageWireSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(NativeToolCallWireSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content: z.string(),
    tool_call_id: z.string(),
  }),
]);

const NativeToolSchemaWireSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

/** 把校验通过的消息逐条构造成 SDK 的判别联合类型——结构对齐，编译器自己认得出，不需要断言。 */
function toOpenAIMessages(messages: unknown[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const parsed = z.array(NativeMessageWireSchema).safeParse(messages);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new NativeCallFailed(
      `messages 形状不对（这是内部契约被打破，不是模型的错）：${issue?.path.join(".") ?? "(顶层)"} ${issue?.message ?? ""}`,
    );
  }

  return parsed.data.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content ?? null,
          tool_calls: m.tool_calls?.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
      case "tool":
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
    }
  });
}

function toOpenAITools(toolSchemas: unknown[]): OpenAI.Chat.ChatCompletionTool[] {
  const parsed = z.array(NativeToolSchemaWireSchema).safeParse(toolSchemas);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new NativeCallFailed(
      `toolSchemas 形状不对（这是内部契约被打破，不是模型的错）：${issue?.path.join(".") ?? "(顶层)"} ${issue?.message ?? ""}`,
    );
  }

  return parsed.data.map((t): OpenAI.Chat.ChatCompletionTool => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/**
 * 把当前对话历史 + 工具定义发给模型，拿到这一轮的原生结果：文本内容和/或若干工具调用。
 *
 * **DeepSeek 默认并行调工具**——一轮返回 2~3 个 `tool_call` 是常态（实测），
 * 每个都要在下一轮消息里配一条对应的 `role:"tool"` 消息，少一条 API 报 400。
 * 这个约束由调用方（`qa/loop-native.ts`）负责，这里只负责如实转发 SDK 给出的
 * `tool_calls` 数组，一个不多一个不少。
 *
 * 重试一次、两次都空（`content` 和 `toolCalls` 都空）则抛 `NativeCallFailed`，
 * 消息带 `finish_reason` 和 token 数——与 `askOnce` 同一处置，理由也一样：
 * 问答循环没有"合理的空结果"可以退回去，必须整体中断。
 */
export async function askOnceNative(
  messages: unknown[],
  toolSchemas: unknown[],
): Promise<NativeTurn> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKey("未设置 DEEPSEEK_API_KEY，请写入 code/.env");
  }

  const oaiMessages = toOpenAIMessages(messages);
  const oaiTools = toOpenAITools(toolSchemas);

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  const whys: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 8192,
      messages: oaiMessages,
      tools: oaiTools,
    });

    const choice = completion.choices[0];
    const finish = choice?.finish_reason ?? "?";
    const outTokens = completion.usage?.completion_tokens ?? -1;
    const message = choice?.message;

    const content = message?.content?.trim();

    // `tool_calls` 的元素类型是 `ChatCompletionMessageFunctionToolCall |
    // ChatCompletionMessageCustomToolCall` 的判别联合，靠 `type === "function"` 收窄——
    // DeepSeek 只会给出 function 类型，但 SDK 类型上仍要求穷尽，不能断言。
    const toolCalls: NativeToolCall[] = [];
    for (const tc of message?.tool_calls ?? []) {
      if (tc.type === "function") {
        toolCalls.push({ id: tc.id, name: tc.function.name, argsRaw: tc.function.arguments });
      }
    }

    if (content || toolCalls.length > 0) {
      return { content: content || null, toolCalls };
    }

    whys.push(`第${attempt}次: 空内容且无 tool_calls (finish_reason=${finish}, 输出 ${outTokens} tokens)`);
  }

  throw new NativeCallFailed(`模型两次都未能返回内容或工具调用——${whys.join("；")}`);
}
