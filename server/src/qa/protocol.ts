import { z } from "zod";

/**
 * **问答**循环里"工具调用长什么样"的唯一定义点。
 *
 * 为什么单独拆一个文件：现在的实现是手搓 JSON——system prompt 里用中文把五种动作的
 * 形状讲清楚，模型输出一段 JSON 文本，我们自己 `JSON.parse` + zod 校验、错了自己兜底重试。
 * 这不是长期形态：DeepSeek 原生支持 `tool_calls`（走 `tools` 参数，模型输出结构化的
 * 函数调用而不是要求它自己拼 JSON 字符串），换成那套之后**协议层完全不同**——
 * 不再需要 `PROTOCOL_PROMPT` 这段大 prompt，也不再需要自己 `JSON.parse` 兜格式错误
 * （SDK/厂商保证调用形状合法，坏格式的责任从"我们捕获并重试"转移到"厂商约束模型输出"）。
 * 但 `qa/loop.ts` 关心的只是"这一步是哪种动作、参数是什么、结果怎么塞回对话"，
 * 这些语义在两种协议下不变。所以把"协议长什么样"整个封在这一个文件里：
 * 换协议只需要重写 `PROTOCOL_PROMPT` / `parseAction` / `renderToolResult` 这三样，
 * `Action` 这个类型契约、以及 `loop.ts` 一行都不用动。**这个可替换性是交付物的一部分。**
 *
 * 手搓协议 vs 原生 tool_calls 的差别，落到代码里主要是两条：
 * 1. 手搓协议下，"格式不对"是一个必然会发生的运行时状态（模型输出多余文字、
 *    漏字段、编个不存在的 kind），必须自己识别并决定"重试还是放弃"（见 `ProtocolError`
 *    与 `qa/loop.ts` 里"连续两次协议错误才放弃"那条）；原生 tool_calls 下这一整类
 *    错误由厂商保证不会发生，`parseAction` 那层校验就不需要了。
 * 2. 手搓协议下，"工具的返回结果"要靠我们自己拼成一段文本追加进 messages
 *    （`renderToolResult`）；原生协议有专门的 `tool` 角色消息装这份结果，
 *    不需要我们手写"人话怎么描述一个结果"。
 */

/** 形状不对（不是合法 JSON，或字段/kind 不匹配）时抛出，调用方决定重试还是放弃。 */
export class ProtocolError extends Error {}

const SearchActionSchema = z.object({
  kind: z.literal("search"),
  query: z.string(),
});

const OutlineActionSchema = z.object({
  kind: z.literal("outline"),
  materialId: z.string(),
});

const ReadActionSchema = z.object({
  kind: z.literal("read"),
  materialId: z.string(),
  line: z.number().int(),
});

const AnswerActionSchema = z.object({
  kind: z.literal("answer"),
  text: z.string(),
  cites: z.array(z.string()), // 材料 id；引用完整性校验在 loop.ts，这里只管形状
});

const NoneActionSchema = z.object({
  kind: z.literal("none"),
  reason: z.string(),
});

/**
 * `z.discriminatedUnion` 而不是 `z.union`：前者按 `kind` 字段直接分派到对应分支，
 * 报错信息能精确到"哪个分支的哪个字段不对"；`z.union` 会把五个分支的错误都堆出来，
 * 对"告诉模型它错在哪"这个用途没帮助。
 */
const ActionSchema = z.discriminatedUnion("kind", [
  SearchActionSchema,
  OutlineActionSchema,
  ReadActionSchema,
  AnswerActionSchema,
  NoneActionSchema,
]);

export type Action =
  | { kind: "search"; query: string }
  | { kind: "outline"; materialId: string }
  | { kind: "read"; materialId: string; line: number }
  | { kind: "answer"; text: string; cites: string[] }
  | { kind: "none"; reason: string };

/**
 * DeepSeek 的 JSON 模式硬性要求 prompt 里出现 "json" 字样、并给出格式示例（照抄
 * `model/keywords.ts` / `model/extract-drills.ts` 已验证过的写法）。
 *
 * 三条硬性规则是这份 prompt 存在的核心理由，直接对应 CLAUDE.md 的两条不可违反性质：
 * "答案只能来自读到的原文" + "没把握就 none，绝不用通用知识补答案"——这是唯一防止
 * 模型拿训练时记住的通用知识蒙混过关的手段，protocol 层没有任何机械校验能拦住这个，
 * 只能在 prompt 里把话说死。
 */
export const PROTOCOL_PROMPT = [
  "你在为一个本地个人知识库回答问题。这个库里的材料是本人自己收录、自己可能都记不清细节的东西，",
  "你自己训练时记住的通用知识很可能是过时的、或者和库里这份材料的具体写法对不上——",
  "**你没有关于这个问题的任何知识，只能通过下面三个工具去读库里的材料，一切以你实际读到的原文为准。**",
  "",
  "每一轮，你必须且只能输出一个 json 对象，代表这一步要做的动作，五选一：",
  "",
  "1. 检索材料（返回若干候选材料的 id、标题、来源）：",
  '   {"kind": "search", "query": "检索词"}',
  "2. 展开一份材料的大纲（它的标题行与整行加粗行，各带行号）：",
  '   {"kind": "outline", "materialId": "材料id"}',
  "3. 读一份材料从某一行开始的一段原文（自动切到下一个同级或更高级标题为止）：",
  '   {"kind": "read", "materialId": "材料id", "line": 12}',
  "4. 给出最终答案：",
  '   {"kind": "answer", "text": "……", "cites": ["材料id1", "材料id2"]}',
  "5. 承认库里没有你需要的答案：",
  '   {"kind": "none", "reason": "为什么找不到"}',
  "",
  "硬性规则（违反这些规则比说「不知道」更糟）：",
  "- **答案只能来自你已经用 read 读到的原文。** cites 里的每个材料 id 必须是你确实用 read",
  "  读到过内容的材料——没有 read 过的材料，既不能出现在 cites 里，也不能作为答案的依据。",
  "- **绝不允许用你自己的通用知识编一个看起来合理但没有出处的答案。** 库里可能没有这个问题",
  "  的答案，也可能库里的说法和你记得的通用知识不一样——都要以你实际读到的原文为准；",
  "  如果搜索/展开/阅读之后仍然找不到支持这个答案的原文，输出 none，不要硬凑。",
  "- 一次只输出一个 json 对象，不要输出多余的文字、注释或多个动作。",
  "- 通常的顺序是先 search 找候选材料、再 outline 看这份材料有哪些位置、再 read 具体某一行；",
  "  不要凭空猜 materialId 或行号。",
].join("\n");

/**
 * 把模型这一轮的原始输出解析成一个 `Action`。
 *
 * 两类失败都归一成 `ProtocolError`：`content` 本身不是合法 JSON；或者是合法 JSON
 * 但形状不满足五选一里的任何一个分支（多余字段、缺字段、`kind` 拼错等）。
 * 调用方（`qa/loop.ts`）拿到这个错误后决定"把错误反馈给模型重来"还是"放弃"，
 * 这里只管识别，不管恢复策略——恢复策略是循环体的事,不是协议层的事。
 */
export function parseAction(content: string): Action {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProtocolError(`模型输出不是合法 JSON：${content.slice(0, 200)}`);
  }

  const result = ActionSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") || "(顶层)";
    throw new ProtocolError(`动作形状不对，字段 ${where}：${issue?.message ?? "未知错误"}`);
  }

  return result.data;
}

/**
 * 把一次工具调用的结果渲染成一段人类可读的文本，供 `qa/loop.ts` 拼回对话历史
 * （下一轮模型会读到这段文本）。
 *
 * `result` 的类型是 `unknown` 而不是从 `qa/tools.ts` 导入的具体类型——这是刻意的，
 * 协议层不应该知道工具层的返回形状长什么样（保持"协议"与"工具实现"解耦，
 * 否则将来两边都不好单独换）。所以这里用 `typeof` / `Array.isArray` 挨个收窄，
 * 而不是 `as` 断言：形状不对时应当降级成"看起来奇怪但不炸"的文本，而不是让编译器
 * 假装我们知道它的形状。
 *
 * `answer` / `none` 是终态动作——循环体见到它们就结束，不会走"执行工具→渲染结果"
 * 这条路径，所以这两个分支不会被真正调用到；这里仍然给出定义只是为了函数在类型上
 * 对全部五种 `Action` 都有确定行为，不留一个隐藏的"这个分支不会被调用"的假设。
 */
export function renderToolResult(action: Action, result: unknown): string {
  switch (action.kind) {
    case "search":
      return renderSearchResult(result);
    case "outline":
      return renderOutlineResult(result);
    case "read":
      return renderReadResult(result);
    case "answer":
    case "none":
      return "";
  }
}

function renderSearchResult(result: unknown): string {
  if (!Array.isArray(result) || result.length === 0) {
    return "没有搜到任何材料，换个检索词试试，或者直接 none。";
  }

  const lines = result.map((item, i) => {
    if (typeof item !== "object" || item === null) return `${i + 1}. (结果格式异常)`;
    const materialId = "materialId" in item && typeof item.materialId === "string" ? item.materialId : "?";
    const title = "title" in item && typeof item.title === "string" ? item.title : "?";
    const from = "from" in item && typeof item.from === "string" ? item.from : undefined;
    const score = "score" in item && typeof item.score === "number" ? item.score.toFixed(2) : "?";
    const fromSuffix = from ? `（来自索引页 ${from}）` : "";
    return `${i + 1}. materialId=${materialId} 《${title}》${fromSuffix} score=${score}`;
  });

  return `搜到 ${result.length} 篇材料：\n${lines.join("\n")}`;
}

function renderOutlineResult(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return "这份材料不存在，materialId 可能错了。";
  }

  const title = "title" in result && typeof result.title === "string" ? result.title : "?";
  const entries = "entries" in result && Array.isArray(result.entries) ? result.entries : [];

  if (entries.length === 0) {
    return `《${title}》没有可展开的候选行（既无标题也无整行加粗），直接 read 感兴趣的行号，或换一篇材料。`;
  }

  const lines: string[] = [];
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue;
    const line = "line" in e && typeof e.line === "number" ? e.line : undefined;
    const text = "text" in e && typeof e.text === "string" ? e.text : undefined;
    if (line === undefined || text === undefined) continue;
    lines.push(`L${line}: ${text.trim()}`);
  }

  return `《${title}》的大纲（标题/加粗行，行号供 read 使用）：\n${lines.join("\n")}`;
}

function renderReadResult(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return "这一行读不到——材料不存在，或者行号越界。";
  }

  const title = "title" in result && typeof result.title === "string" ? result.title : "?";
  const text = "text" in result && typeof result.text === "string" ? result.text : "";

  return `《${title}》原文片段：\n${text}`;
}
