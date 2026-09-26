/**
 * **问答**的循环体：一条自己手写的 agent 循环，绝不引入 LangChain / 任何 harness——
 * 本项目的目的之一就是学 agent 怎么工作，把循环抽象掉就学不到了。
 *
 * 这个文件只管"何时停、怎么把结果拼回去、轮数上限"，完全不知道"工具调用长什么样"
 * ——那是 `qa/protocol.ts` 的职责，见那个文件顶部注释。`runAsk` 里唯一从 protocol.ts
 * 借来的知识是"五种动作各自叫什么 kind"，除此之外不解析、不校验任何 JSON。
 */

import { toolSearch, toolOutline, toolRead, type ToolContext } from "./tools.js";
import { PROTOCOL_PROMPT, parseAction, renderToolResult, ProtocolError, type Action } from "./protocol.js";
import type { ChatMessage } from "../model/answer.js";

/**
 * 步骤流里除了协议定义的五种**动作**，还有一种只在这条循环内部发生的事：模型没按格式说话。
 *
 * **它不能复用 `{kind:"none"}`**——`none` 在协议里的含义是「承认库里没有答案」，
 * 那是一个关于**库**的事实；而协议错误是关于**模型输出**的事实。两者共用一个名字的
 * 直接后果：界面会把「模型吐了段乱码」显示成「库里没有这个问题的答案」，
 * 而本人据此得出的结论（该去收录一篇）是错的。
 * 这就是 `CONTEXT.md` 那套「术语是有约束力的」落在代码里的同一件事。
 */
export type StepEvent = Action | { kind: "protocol_error"; message: string };

export interface Step {
  round: number;
  action: StepEvent;
  resultSummary: string;
}

export interface AskResult {
  question: string;
  steps: Step[];
  /** null = 库里没有（含"none 动作""触顶""连续协议错误放弃""引用全部作废降级"四种成因） */
  answer: string | null;
  /** 材料 id，已通过引用完整性校验——每一个都真的被 toolRead 成功读过 */
  cites: string[];
  rounds: number;
  hitLimit: boolean;
}

export interface AskDeps {
  ctx: ToolContext;
  askOnce: (messages: ChatMessage[]) => Promise<string>;
  onStep?: (s: Step) => void;
}

const DEFAULT_MAX_ROUNDS = 6;

/** `steps[].resultSummary` 只是给人/日志看的预览，超长截断——不影响真正拼回 messages 的完整内容。 */
const SUMMARY_PREVIEW_LEN = 200;

/** 连续几次协议错误就放弃，不再无限期给模型重试机会（否则一个一直输出垃圾的模型会把 maxRounds 全部耗在"重来"上）。 */
const MAX_CONSECUTIVE_PROTOCOL_ERRORS = 2;

function previewOf(text: string): string {
  return text.length > SUMMARY_PREVIEW_LEN ? `${text.slice(0, SUMMARY_PREVIEW_LEN)}…` : text;
}

export async function runAsk(
  question: string,
  deps: AskDeps,
  opts?: { maxRounds?: number },
): Promise<AskResult> {
  const maxRounds = opts?.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const messages: ChatMessage[] = [
    { role: "system", content: PROTOCOL_PROMPT },
    { role: "user", content: question },
  ];

  const steps: Step[] = [];

  // **引用完整性的凭证集合**：只有经 toolRead 成功读到内容（非 null）的材料 id 才进这里。
  // 最终 answer 里的 cites 会拿这个集合过滤——不在这个集合里的引用，不管模型多笃定，
  // 都必须被剔除，因为"模型不得凭空引用一个它没读过的材料"是三条不可违反性质里的第一条。
  const readMaterialIds = new Set<string>();

  let consecutiveProtocolErrors = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // **最后一轮先把话说明白：工具没了，只能 answer 或 none。**
    // 实测逼出来的（2026-09-26，真实问了一句库里肯定没有的「Rust 所有权怎么工作」）：
    // 模型连搜五次、换了五个检索词，**一次都没有主动选 none**，最后是靠触顶降级才得到
    // 「库里没有」。根因是 **BM25 永远会返回候选，即使全不相关**（CLAUDE.md 在归属那节
    // 已经写过这条），于是模型每一轮都看到五篇"命中"，以为还有戏。
    // 加这一句不引入新常数——`maxRounds` 本来就在那儿，这只是把它**告诉**模型；
    // 收益是把一次沉默的触顶变成一条带理由的 none，**「库里没有」于是成为一个判断而不是一个副作用**。
    if (round === maxRounds) {
      messages.push({
        role: "user",
        content:
          "这是最后一轮，不能再调用 search / outline / read 了。" +
          "如果你已经用 read 读到了支持答案的原文，就输出 answer；" +
          "否则输出 none 并说明库里缺什么——不要拿通用知识硬凑。",
      });
    }

    const raw = await deps.askOnce(messages);

    let action: Action;
    try {
      action = parseAction(raw);
    } catch (err) {
      // 协议错误不让整条循环崩掉：把错误原文当成一条 user 消息拼回去，告诉模型
      // "格式不对，重来"，这一轮照样计入 rounds（不能白给一轮不算数的重试机会，
      // 否则一个一直输出垃圾的模型可以无限期占用这个循环）。
      consecutiveProtocolErrors++;
      const reason = err instanceof ProtocolError ? err.message : String(err);

      const step: Step = {
        round,
        action: { kind: "protocol_error", message: reason },
        resultSummary: "模型输出不是合法的动作 json，已要求重新输出",
      };
      steps.push(step);
      deps.onStep?.(step);

      if (consecutiveProtocolErrors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
        // 连续两次都解析不出合法动作——不再给机会，直接降级为"库里没有"，
        // 而不是把 maxRounds 剩下的轮次全耗在"再试一次"上
        return { question, steps, answer: null, cites: [], rounds: round, hitLimit: false };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `你上一步的输出不是合法的动作 json：${reason}\n请重新只输出一个五选一的 json 动作，不要输出多余文字。`,
      });
      continue;
    }

    consecutiveProtocolErrors = 0;

    if (action.kind === "answer") {
      // 引用完整性校验：过滤掉没有经 toolRead 读过的材料 id
      const validCites = action.cites.filter((id) => readMaterialIds.has(id));

      const step: Step = {
        round,
        action,
        resultSummary:
          validCites.length > 0
            ? `给出答案，引用 ${validCites.length} 篇已读材料`
            : "给出答案，但 cites 里没有一个是真的读过的材料——整体降级为「库里没有」",
      };
      steps.push(step);
      deps.onStep?.(step);

      // 过滤后为空——等同"库里没有"，不能让一个查无实据的答案漏出去
      if (validCites.length === 0) {
        return { question, steps, answer: null, cites: [], rounds: round, hitLimit: false };
      }
      return { question, steps, answer: action.text, cites: validCites, rounds: round, hitLimit: false };
    }

    if (action.kind === "none") {
      const step: Step = { round, action, resultSummary: `库里没有：${action.reason}` };
      steps.push(step);
      deps.onStep?.(step);
      return { question, steps, answer: null, cites: [], rounds: round, hitLimit: false };
    }

    // 剩下三种是工具动作：search / outline / read——真正执行，把结果拼回对话历史
    let result: unknown;
    if (action.kind === "search") {
      result = toolSearch(deps.ctx, action.query);
    } else if (action.kind === "outline") {
      result = toolOutline(deps.ctx, action.materialId);
    } else {
      result = toolRead(deps.ctx, action.materialId, action.line);
      // 只有真的读到内容（非 null）才记入"读过"的凭证——材料不存在或行号越界
      // 不能算数，否则模型可以拿一个读不到的 materialId 骗过引用完整性校验
      if (result !== null) {
        readMaterialIds.add(action.materialId);
      }
    }

    const rendered = renderToolResult(action, result);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: rendered });

    const step: Step = { round, action, resultSummary: previewOf(rendered) };
    steps.push(step);
    deps.onStep?.(step);
  }

  // 循环跑完 maxRounds 轮仍未得到 answer/none——触顶，降级为"库里没有"。
  // 触顶不是失败，是合法终态：CLAUDE.md「三条不可违反的性质」第 2 条明确要求
  // "循环触顶（hitLimit）也降级为 answer: null"。
  return { question, steps, answer: null, cites: [], rounds: maxRounds, hitLimit: true };
}
