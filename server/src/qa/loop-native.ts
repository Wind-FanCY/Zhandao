/**
 * **问答**循环体的原生 `tool_calls` 对应物——`qa/loop.ts` 的对照实现。
 *
 * 两份循环体的骨架逐字相同（何时停、怎么把结果拼回去、轮数上限），差异全部来自
 * "工具调用怎么表达"这一层，而这正是 `qa/protocol.ts` / `qa/protocol-native.ts`
 * 分工存在的理由。逐条对账：
 *
 * **消失的代码**：
 * - `parseAction` 的整段 try/catch 与"连续两次协议错误就放弃"那套熔断
 *   （`consecutiveProtocolErrors` / `MAX_CONSECUTIVE_PROTOCOL_ERRORS`）。
 *   手搓协议下"模型输出的整段 content 都不是合法 json"是一个必然会发生的运行时状态，
 *   需要熔断防止一直重试；原生协议下"这一轮说了什么"由 SDK 直接给出结构
 *   （`content` 或 `tool_calls`），不存在"整段解析失败、不知道模型想干嘛"这种情况，
 *   **熔断机制因此整个不需要**——这条不是"变简单了"，是"这一类失败被移到了更细的粒度"，
 *   见下面「新出现的代码」。
 * - `renderToolResult(action, result)` 结果手动拼成 `role:"user"` 消息那一步的"决定用
 *   哪个角色装结果"这层判断消失了——原生协议规定工具结果必须是 `role:"tool"` 消息，
 *   不是选择，是格式要求。
 * - "最后一轮告诉模型工具没了"那条 user 消息仍然存在（见下），但手搓协议里它还要
 *   顺带重申"只能输出 answer 或 none 的 json"——原生协议下不需要，模型这一轮
 *   只要不带 `tool_calls` 地给出文本就是终态，不需要再遵守格式。
 *
 * **新出现的代码**：
 * - **一轮多个 `tool_call` 的分派循环**。手搓协议一次只表达一个动作，`for` 循环体
 *   天然是"一轮一动作"；原生协议下 DeepSeek **默认并行调工具**，一轮常见 2~3 个
 *   `tool_call`，必须在同一个 `round` 里跑完全部、且每个都要生成一条独立的
 *   `role:"tool"` 消息塞回历史——**少回一条 API 就 400**，这条约束在手搓协议下
 *   根本不存在（手搓协议没有"一条工具调用对应一条回执"这种强绑定）。
 * - **每个 `tool_call` 各自的参数校验失败处理**（`nativeCallToAction` 抛出的
 *   `ProtocolError`）。这是上面提到的"失败被移到更细粒度"：手搓协议的协议错误是
 *   "整轮说的话解析不出动作"，原生协议的协议错误是"这一个具体的工具调用参数不对"——
 *   前者要熔断防止无限重试，后者只需要把错误塞进对应的 `tool` 消息、让模型在下一轮
 *   看到"这次参数错了"就行，不需要熔断（每个坏调用最多占用一轮的预算，`maxRounds`
 *   本身就是天然的上限，不需要再叠一层计数器）。
 * - **引用完整性变成构造性质而非事后过滤**。手搓协议里 `answer` 动作自带 `cites`
 *   字段、循环体要用 `readMaterialIds` 过滤掉模型编造的引用；原生协议下模型给出的
 *   最终文本根本没有 `cites` 字段（普通文本回答不携带结构化引用），所以 `cites`
 *   **只能**是"这一轮循环里真的 read 成功过的材料集合"本身，没有"过滤"这一步——
 *   模型物理上没有地方去编造一个假引用。**这是全篇最大的一处简化**，但代价是
 *   最终答案里模型不能自己挑选"这次回答实际引用了哪几篇"，凡是这次循环里 read
 *   过的材料，不管答案有没有真的用到，全部进 cites。
 *
 * **不变的代码**：轮数上限、`readMaterialIds` 集合本身的语义（只有 `toolRead`
 * 返回非 null 才记入）、触顶降级为 `answer:null`、`AskResult` / `Step` 的形状、
 * `qa/tools.ts` 三个工具函数——一行都不需要改，`qa/protocol-native.ts` 的
 * `nativeCallToAction` 产出的还是原来那个 `Action` 类型。
 */

import { toolSearch, toolOutline, toolRead, type ToolContext } from "./tools.js";
import { ProtocolError, type Action } from "./protocol.js";
import { TOOL_SCHEMAS, NATIVE_SYSTEM_PROMPT, nativeCallToAction, renderToolResult } from "./protocol-native.js";
import type { NativeTurn } from "../model/answer-native.js";
import { readSourceOf, type AskResult, type Step, type ReadSource } from "./loop.js";

export interface AskNativeDeps {
  ctx: ToolContext;
  /** 可注入，测试用假实现替换——绝不在测试里真的调 DeepSeek。 */
  askOnceNative: (messages: unknown[], toolSchemas: unknown[]) => Promise<NativeTurn>;
  onStep?: (s: Step) => void;
}

const DEFAULT_MAX_ROUNDS = 6;

/** 与 `qa/loop.ts` 同一个常数、同一个理由：`steps[].resultSummary` 只是给人看的预览。 */
const SUMMARY_PREVIEW_LEN = 200;

function previewOf(text: string): string {
  return text.length > SUMMARY_PREVIEW_LEN ? `${text.slice(0, SUMMARY_PREVIEW_LEN)}…` : text;
}

/**
 * 把一个 `NativeToolCall` 数组转成下一轮要塞回历史的 `assistant` 消息里的
 * `tool_calls` 字段——形状是 wire 格式（`function.arguments` 是原始 JSON 字符串），
 * 与 `model/answer-native.ts` 里 `toOpenAIMessages` 校验的 schema 对应。
 */
function toWireToolCalls(toolCalls: { id: string; name: string; argsRaw: string }[]) {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.argsRaw },
  }));
}

export async function runAskNative(
  question: string,
  deps: AskNativeDeps,
  opts?: { maxRounds?: number },
): Promise<AskResult> {
  const maxRounds = opts?.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const messages: unknown[] = [
    { role: "system", content: NATIVE_SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const steps: Step[] = [];

  // 与 qa/loop.ts 同一个集合、同一条规则：只有 toolRead 真的返回非 null 才记入。
  // 原生协议下这个集合还多担一份工作——它**就是**最终答案的 cites，不再需要过滤
  // 模型自己声明的引用（原生答案没有 cites 字段可供声明），见文件头「新出现的代码」。
  const readMaterialIds = new Set<string>();

  // **「它到底有没有去找过」的凭证。** 与 `readMaterialIds` 是两回事：
  // 那个只认 `read`，这个认任何一次成功发出的工具调用（search / outline 也算找）。
  // 它决定「纯文本零引用」这个终态是 not_found（找过了，收录信号）还是 aborted（没找，不留记录）。
  let usedAnyTool = false;

  for (let round = 1; round <= maxRounds; round++) {
    // 最后一轮先告诉模型工具没了，理由与 qa/loop.ts 完全一样（那是实测逼出来的：
    // BM25 永远会返回候选，模型不会主动意识到"库里没有"，需要明确提醒它工具预算用完了）。
    // 与手搓协议的版本相比少了"只能输出 answer 或 none 的 json"这半句——原生协议下
    // "给出最终答案"就是不带 tool_calls 的纯文本，不需要重申格式。
    if (round === maxRounds) {
      messages.push({
        role: "user",
        content:
          "这是最后一轮，不能再调用任何工具了。" +
          "如果你已经用 read 读到了支持答案的原文，直接输出最终的文字回答；" +
          "否则直接说明库里没有这方面的材料——不要拿通用知识硬凑，也不要再调用工具。",
      });
    }

    const turn = await deps.askOnceNative(messages, TOOL_SCHEMAS);

    if (turn.toolCalls.length === 0) {
      // 没有工具调用、有文本内容——这就是终态。
      // **原生协议没有 `none` 这个动作**，「库里没有」和「我直接答了」长得一模一样，
      // 都是"纯文本 + 零引用"。但这两者指向相反的动作，**不能合并**：
      //
      //   从没调过任何工具就给文本   → 拿通用知识蒙的，**与库无关** → aborted，不落盘
      //   搜过/看过目录但没值得读的 → **它确实去找了**，这是真的收录信号 → not_found
      //
      // 判据用的是 `usedAnyTool` 而不是 `readMaterialIds`：**`read` 不是「找」，
      // `search` 才是**。只看有没有 read 过，会把「找遍了确实没有」误判成「模型没干活」，
      // 于是 `asks.jsonl` 里的收录信号在原生路径上会整个消失——
      // 而那是 `found:false` 那些行存在的全部理由（CLAUDE.md）。
      const cites = Array.from(readMaterialIds);
      const text = turn.content ?? "";

      const step: Step = {
        round,
        action: { kind: "answer", text, cites },
        resultSummary:
          cites.length > 0
            ? `给出答案，引用 ${cites.length} 篇已读材料`
            : usedAnyTool
              ? "找过了但没读到可引用的原文——判为「库里没有」"
              : "一个工具都没调就给了文本——判为「这次没问成」，不留记录",
      };
      steps.push(step);
      deps.onStep?.(step);

      if (cites.length === 0) {
        return {
          question,
          steps,
          answer: null,
          cites: [],
          rounds: round,
          hitLimit: false,
          outcome: usedAnyTool ? "not_found" : "aborted",
        };
      }
      return { question, steps, answer: text, cites, rounds: round, hitLimit: false, outcome: "answered" };
    }

    // 有工具调用：**必须先把这一整轮的 assistant 消息（可能带多个并行 tool_calls）
    // 拼回历史，再给每一个 tool_call 各自执行、各自回一条 role:"tool" 消息**——
    // 少回一条 API 就 400，这是与手搓协议行为差异最大的一处（见文件头）。
    usedAnyTool = true;

    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: toWireToolCalls(turn.toolCalls),
    });

    for (const call of turn.toolCalls) {
      let action: Action;
      try {
        action = nativeCallToAction(call);
      } catch (err) {
        // 参数形状不对——不熔断（不像手搓协议那样数"连续几次"），因为每个坏调用
        // 最多占用这一轮里这一个 tool_call 的预算，maxRounds 本身就是天然上限。
        // 把错误原样回给模型（放进对应的 tool 消息），让它下一轮自己纠正。
        const reason = err instanceof ProtocolError ? err.message : String(err);
        const step: Step = {
          round,
          action: { kind: "protocol_error", message: reason },
          resultSummary: "工具参数形状不对，已把错误原样回给模型",
        };
        steps.push(step);
        deps.onStep?.(step);

        messages.push({ role: "tool", tool_call_id: call.id, content: `参数错误：${reason}` });
        continue;
      }

      let result: unknown;
      // 成功的 read 要把**未截断的原文**一并带进步骤，界面据此渲染「出处原文」。
      // 理由见 qa/loop.ts 的 ReadSource：答案是转述，而我们只保证了「引用是真的」，
      // 没保证「内容忠于出处」——把原文摆出来，让偏差变成可见的。
      let source: ReadSource | undefined;
      switch (action.kind) {
        case "search":
          result = toolSearch(deps.ctx, action.query);
          break;
        case "outline":
          result = toolOutline(deps.ctx, action.materialId);
          break;
        case "read":
          result = toolRead(deps.ctx, action.materialId, action.line);
          // 只有真的读到内容（非 null）才记入"读过"的凭证——与 qa/loop.ts 同一条规则。
          if (result !== null) {
            readMaterialIds.add(action.materialId);
            source = readSourceOf(action.materialId, action.line, result);
          }
          break;
        case "answer":
        case "none":
          // nativeCallToAction 按构造只会产出 search/outline/read 三种
          // （见 qa/protocol-native.ts 的 switch(call.name)），这两个分支物理上不可达——
          // 写出来只是穷尽 Action 的判别联合，让 TS 确认下面用到 action 的地方类型已收窄完毕。
          throw new ProtocolError(`nativeCallToAction 不应该产出 ${action.kind} 动作，这是内部不变量被打破`);
      }

      const rendered = renderToolResult(action, result);
      messages.push({ role: "tool", tool_call_id: call.id, content: rendered || "(空结果)" });

      const step: Step = {
        round,
        action,
        resultSummary: previewOf(rendered),
        ...(source ? { source } : {}),
      };
      steps.push(step);
      deps.onStep?.(step);
    }
  }

  // 触顶——与 qa/loop.ts 同一条规则：不是失败，是合法终态。
  return { question, steps, answer: null, cites: [], rounds: maxRounds, hitLimit: true, outcome: "not_found" };
}
