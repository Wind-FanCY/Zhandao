/**
 * 对照实验脚本：`npm run ask-compare -- "问题" [--runs 3]`
 *
 * 对同一个问题，把手搓 JSON 协议（`qa/loop.ts` + `model/answer.ts`）和
 * DeepSeek 原生 `tools`/`tool_calls`（`qa/loop-native.ts` + `model/answer-native.ts`）
 * 各跑 N 次，打印一张对照表：每次的轮数、模型调用次数、工具调用次数、耗时、
 * 是否出现协议错误、found、引用了几篇。
 *
 * **这个脚本真的会调 DeepSeek，会花钱。** 不属于 `npm test` 的一部分，
 * 也不该被 CI 或任何自动化流程触发——由本人手动跑。
 *
 * 两条路径共用同一个 `MaterialsIndex`（同一次收录状态下比较，不受"跑的时候库变了"干扰）。
 * "模型调用次数"是给 `askOnce` / `askOnceNative` 包一层计数器得到的，不是从 steps 里数出来的——
 * `steps` 里协议错误重试也会占一个 round，但一个 round 不一定只调一次模型
 * （原生协议一轮可能带多个 tool_call，但那仍然只对应**一次** `askOnceNative` 调用，
 * 一次调用可能同时产出好几个 tool_call）。"工具调用次数"才是数 steps 里
 * search/outline/read 三种动作的个数。
 */

import { runAsk } from "../qa/loop.js";
import { askOnce, type ChatMessage } from "../model/answer.js";
import { runAskNative } from "../qa/loop-native.js";
import { askOnceNative } from "../model/answer-native.js";
import { buildMaterialsIndex, type MaterialsIndex } from "../search/materials-index.js";
import type { ToolContext } from "../qa/tools.js";
import { initializeRuntime } from "../runtime.js";

interface RunStats {
  rounds: number;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  hadProtocolError: boolean;
  found: boolean;
  citesCount: number;
}

const TOOL_ACTION_KINDS = new Set(["search", "outline", "read"]);

async function runHandwrittenOnce(question: string, ctx: ToolContext): Promise<RunStats> {
  let modelCalls = 0;
  const countedAskOnce = async (messages: ChatMessage[]): Promise<string> => {
    modelCalls += 1;
    return askOnce(messages);
  };

  const startedAt = Date.now();
  const result = await runAsk(question, { ctx, askOnce: countedAskOnce });
  const durationMs = Date.now() - startedAt;

  const toolCalls = result.steps.filter((s) => TOOL_ACTION_KINDS.has(s.action.kind)).length;
  const hadProtocolError = result.steps.some((s) => s.action.kind === "protocol_error");

  return {
    rounds: result.rounds,
    modelCalls,
    toolCalls,
    durationMs,
    hadProtocolError,
    found: result.answer !== null,
    citesCount: result.cites.length,
  };
}

async function runNativeOnce(question: string, ctx: ToolContext): Promise<RunStats> {
  let modelCalls = 0;
  const countedAskOnceNative = async (messages: unknown[], toolSchemas: unknown[]) => {
    modelCalls += 1;
    return askOnceNative(messages, toolSchemas);
  };

  const startedAt = Date.now();
  const result = await runAskNative(question, { ctx, askOnceNative: countedAskOnceNative });
  const durationMs = Date.now() - startedAt;

  const toolCalls = result.steps.filter((s) => TOOL_ACTION_KINDS.has(s.action.kind)).length;
  const hadProtocolError = result.steps.some((s) => s.action.kind === "protocol_error");

  return {
    rounds: result.rounds,
    modelCalls,
    toolCalls,
    durationMs,
    hadProtocolError,
    found: result.answer !== null,
    citesCount: result.cites.length,
  };
}

function fmtRow(label: string, s: RunStats): string {
  return (
    `${label.padEnd(10)}` +
    `轮数=${String(s.rounds).padStart(2)}  ` +
    `模型调用=${String(s.modelCalls).padStart(2)}  ` +
    `工具调用=${String(s.toolCalls).padStart(2)}  ` +
    `耗时=${String(s.durationMs).padStart(6)}ms  ` +
    `协议错误=${s.hadProtocolError ? "是" : "否"}  ` +
    `found=${s.found ? "是" : "否"}  ` +
    `cites=${s.citesCount}`
  );
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function summarize(label: string, runs: RunStats[]): string {
  const foundRate = runs.filter((r) => r.found).length / runs.length;
  const errorRate = runs.filter((r) => r.hadProtocolError).length / runs.length;
  return (
    `${label.padEnd(10)}` +
    `平均轮数=${average(runs.map((r) => r.rounds)).toFixed(1)}  ` +
    `平均模型调用=${average(runs.map((r) => r.modelCalls)).toFixed(1)}  ` +
    `平均工具调用=${average(runs.map((r) => r.toolCalls)).toFixed(1)}  ` +
    `平均耗时=${average(runs.map((r) => r.durationMs)).toFixed(0)}ms  ` +
    `协议错误率=${(errorRate * 100).toFixed(0)}%  ` +
    `found率=${(foundRate * 100).toFixed(0)}%  ` +
    `平均cites=${average(runs.map((r) => r.citesCount)).toFixed(1)}`
  );
}

async function main(): Promise<void> {
  initializeRuntime();

  const args = process.argv.slice(2);
  const runsFlagIdx = args.indexOf("--runs");
  const runs = runsFlagIdx >= 0 ? Number(args[runsFlagIdx + 1]) : 3;
  const question = args.filter((a, i) => a !== "--runs" && i !== runsFlagIdx + 1).join(" ").trim();

  if (!question) {
    console.error('用法：npm run ask-compare -- "问题" [--runs 3]');
    process.exit(1);
  }
  if (!Number.isInteger(runs) || runs <= 0) {
    console.error("--runs 必须是正整数");
    process.exit(1);
  }

  console.log(`问题：${question}`);
  console.log(`每条路径各跑 ${runs} 次\n`);

  const index: MaterialsIndex = await buildMaterialsIndex();
  const ctx: ToolContext = { index };

  const handwrittenRuns: RunStats[] = [];
  const nativeRuns: RunStats[] = [];

  for (let i = 1; i <= runs; i++) {
    const h = await runHandwrittenOnce(question, ctx);
    handwrittenRuns.push(h);
    console.log(fmtRow(`手搓 #${i}`, h));

    const n = await runNativeOnce(question, ctx);
    nativeRuns.push(n);
    console.log(fmtRow(`原生 #${i}`, n));
  }

  console.log("\n汇总：");
  console.log(summarize("手搓", handwrittenRuns));
  console.log(summarize("原生", nativeRuns));
}

main().catch((err) => {
  console.error("[ask-compare] 错误：", err instanceof Error ? err.message : err);
  process.exit(1);
});
