import { z } from "zod";
import { ProtocolError, renderToolResult, type Action } from "./protocol.js";
import type { NativeToolCall } from "../model/answer-native.js";

/**
 * `qa/protocol.ts` 的原生 `tool_calls` 对应物——**这一整份实验的主要产出是这份对照**，
 * 不是代码本身。`protocol.ts` 文件头预言了换成原生之后会发生什么，这里逐条对账：
 *
 * **消失的代码**（原生协议由厂商保证，不再需要我们自己写）：
 * - `PROTOCOL_PROMPT` 里"五选一 json 长什么样"的格式说明（原 `protocol.ts` 105 行里
 *   占了将近一半，2~4 号动作的字段示例、"一次只输出一个 json 对象"这类格式纪律）。
 *   `NATIVE_SYSTEM_PROMPT` 只剩硬性规则，短了一半还多——**这条预言成立**。
 * - "content 不是合法 JSON"这整类失败（`parseAction` 里 `JSON.parse` 那个 try/catch）。
 *   原生协议下，模型要么给 `tool_calls`（SDK 保证是合法的 `{id, type, function:{name,
 *   arguments}}` 结构），要么给纯文本，**没有"文本里夹了个不完整 json"这种状态**——
 *   **这条预言成立**。
 * - `answer` / `none` 两个"动作"本身消失了：原生协议里最终回答不是一种要被解析的
 *   json 动作，就是模型直接给的文本内容；`renderToolResult` 因此也用不上那两个分支
 *   （虽然函数本身复用，见下）。
 *
 * **没有消失、只是挪了地方的代码**（这条修正了 `protocol.ts` 头注释里"parseAction 那层
 * 校验就不需要了"的说法——**这条预言不完全成立**）：
 * - `nativeCallToAction` 仍然要做**参数级**的形状校验。CLAUDE.md 明确写着 DeepSeek
 *   "没有严格 JSON Schema"，`tools` 参数只是提示，不是强制契约——模型完全可能给
 *   `read` 工具传一个字符串形态的 `line`，或者漏掉 `materialId`。SDK 保证的只是
 *   "外层结构是合法的 tool_call"（有 `id`、`function.name`、`function.arguments`
 *   这几个字段），**不保证 `arguments` 里那段 JSON 字符串符合我们声明的 parameters
 *   schema**。所以校验并没有消失，只是从"整段 content 是不是合法 json 及五选一之一"
 *   收窄成"这个具体工具的参数对不对"，且分裂成三份小 schema 而不是一个大的
 *   discriminated union。
 *
 * **新出现的代码**：
 * - `TOOL_SCHEMAS`——把"三个工具怎么用"从**中文 prompt 里的自然语言描述**换成
 *   **结构化的 JSON Schema**，这是原生协议要求的输入形式，手搓协议没有对应物。
 * - `nativeCallToAction` 要处理"模型调用了一个不在 `TOOL_SCHEMAS` 里的工具名"这个
 *   手搓协议里不存在的失败模式（手搓协议下"工具名"和"kind"是同一个字段、由
 *   `z.discriminatedUnion` 统一校验；原生协议下"调用哪个工具"和"参数对不对"
 *   是两层校验，会各自失败）。
 *
 * **复用、不重写的代码**：`renderToolResult`——工具执行结果怎么渲染成给模型看的文本，
 * 这件事和"协议是手搓 json 还是原生 tool_calls"无关，只和"工具返回了什么形状的数据"
 * 有关，所以原样从 `protocol.ts` 引入。**这条修正了头注释里"不需要手写 renderToolResult"
 * 的说法——这条预言不成立**：原生协议确实提供了专门的 `tool` 角色消息装结果
 * （不用像手搓协议那样把结果拼成一段 `role:"user"` 文本），但"这段结果给模型看时
 * 该说成人话"这件事本身没有被原生协议接管，`tool` 消息的 `content` 字段仍然是
 * 一段我们自己写的文本，只是装它的信封换了。
 */

// ---- 三个工具的 JSON Schema 定义，描述照抄 PROTOCOL_PROMPT 里对应的自然语言 ----

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "search",
      description:
        "检索库里的材料，返回若干候选材料的 id、标题、来源。" +
        "通常作为第一步：先搜出候选材料，再用 outline / read 深入某一篇。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，几个关键词即可，不必是完整问句" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "outline",
      description:
        "展开一份材料的大纲：它的全部标题行与整行加粗行，各自带上行号。" +
        "用来判断这篇材料里哪个位置可能有你要的答案，从而决定接下来 read 哪一行。",
      parameters: {
        type: "object",
        properties: {
          materialId: { type: "string", description: "材料 id，必须来自 search 或 outline 已经见过的结果，不要凭空猜" },
        },
        required: ["materialId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "读一份材料从某一行开始的一段原文，自动切到下一个同级或更高级标题为止。" +
        "line 必须来自 outline 返回的行号，不要凭空猜行号。",
      parameters: {
        type: "object",
        properties: {
          materialId: { type: "string", description: "材料 id" },
          line: { type: "integer", description: "起始行号，来自 outline 的结果" },
        },
        required: ["materialId", "line"],
      },
    },
  },
];

/**
 * 原生协议下的 system prompt——**只剩硬性规则**，不讲"json 长什么样"（`tools` 参数
 * 本身就是格式契约，厂商保证输出符合它），也不讲"五选一"（工具调用与"给出最终答案"
 * 是两种不同的模型行为：前者是 `tool_calls`，后者是不带 `tool_calls` 的纯文本，
 * 由 SDK 的 `finish_reason` 区分，不需要我们在 prompt 里额外定义一种"answer 动作"）。
 *
 * 三条硬性规则与 `PROTOCOL_PROMPT` 逐字对应，一个字都不能松——它们防的是同一件事
 * （模型拿训练时记住的通用知识蒙混过关），协议怎么换都不影响这件事本身的风险。
 */
export const NATIVE_SYSTEM_PROMPT = [
  "你在为一个本地个人知识库回答问题。这个库里的材料是本人自己收录、自己可能都记不清细节的东西，",
  "你自己训练时记住的通用知识很可能是过时的、或者和库里这份材料的具体写法对不上——",
  "**你没有关于这个问题的任何知识，只能通过 search / outline / read 三个工具去读库里的材料，一切以你实际读到的原文为准。**",
  "",
  "硬性规则（违反这些规则比说「不知道」更糟）：",
  "- **答案只能来自你已经用 read 读到的原文。** 没有 read 过的材料，不能作为答案的依据，",
  "  也不要在最终回答里提到你没有 read 过的材料。",
  "- **绝不允许用你自己的通用知识编一个看起来合理但没有出处的答案。** 库里可能没有这个问题",
  "  的答案，也可能库里的说法和你记得的通用知识不一样——都要以你实际读到的原文为准；",
  "  如果调用工具之后仍然找不到支持这个答案的原文，直接告诉本人库里没有这方面的材料，",
  "  不要硬凑一个答案出来。",
  "- 通常的顺序是先 search 找候选材料、再 outline 看这份材料有哪些位置、再 read 具体某一行；",
  "  不要凭空猜 materialId 或行号，它们必须来自前面工具调用真实返回的结果。",
  "- 当你已经读到足够支持回答的原文、或者确认库里没有答案时，直接输出你的最终文字回答，",
  "  不要再调用任何工具。",
].join("\n");

// ---- 把模型这一次的 tool_call 转成已有的 Action（search/outline/read 三种） ----

const SearchArgsSchema = z.object({ query: z.string() });
const OutlineArgsSchema = z.object({ materialId: z.string() });
const ReadArgsSchema = z.object({ materialId: z.string(), line: z.number().int() });

/**
 * 把一个原生 `tool_call` 转成 `Action`（从 `./protocol.js` 复用同一个类型，
 * 循环体 `qa/loop-native.ts` 因此可以复用 `qa/tools.ts` 里按 `Action` 分派的执行逻辑，
 * 不需要为原生协议另写一套调度）。
 *
 * `call.argsRaw` 是模型生成的 JSON 字符串——**仍然是外部数据**，DeepSeek 的 `tools`
 * 参数不提供严格 schema 校验（CLAUDE.md 已记录），所以这里必须真的校验，
 * 不能假设它一定符合我们在 `TOOL_SCHEMAS` 里声明的形状。两类失败都归一成
 * `ProtocolError`（复用 `protocol.ts` 的类）：`argsRaw` 本身不是合法 JSON；
 * 或者是合法 JSON 但字段形状不对；或者 `call.name` 根本不是三个工具之一。
 */
export function nativeCallToAction(call: NativeToolCall): Action {
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.argsRaw);
  } catch {
    throw new ProtocolError(
      `工具 ${call.name} 的参数不是合法 JSON：${call.argsRaw.slice(0, 200)}`,
    );
  }

  switch (call.name) {
    case "search": {
      const result = SearchArgsSchema.safeParse(parsedArgs);
      if (!result.success) {
        throw new ProtocolError(`search 参数形状不对：${result.error.issues[0]?.message ?? "未知错误"}`);
      }
      return { kind: "search", query: result.data.query };
    }
    case "outline": {
      const result = OutlineArgsSchema.safeParse(parsedArgs);
      if (!result.success) {
        throw new ProtocolError(`outline 参数形状不对：${result.error.issues[0]?.message ?? "未知错误"}`);
      }
      return { kind: "outline", materialId: result.data.materialId };
    }
    case "read": {
      const result = ReadArgsSchema.safeParse(parsedArgs);
      if (!result.success) {
        throw new ProtocolError(`read 参数形状不对：${result.error.issues[0]?.message ?? "未知错误"}`);
      }
      return { kind: "read", materialId: result.data.materialId, line: result.data.line };
    }
    default:
      throw new ProtocolError(`模型调用了未知工具：${call.name}`);
  }
}

// 复用 protocol.ts 的 renderToolResult，不重写——见文件头「复用、不重写的代码」。
export { renderToolResult };
