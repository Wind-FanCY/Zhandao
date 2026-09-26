import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildMaterialsIndex, type MaterialsIndex } from "../search/materials-index.js";
import { runAskNative, type AskNativeDeps } from "./loop-native.js";
import type { ToolContext } from "./tools.js";
import type { NativeTurn, NativeToolCall } from "../model/answer-native.js";

// runAskNative 绝不真的调模型——askOnceNative 全部是注入的假实现。
// ctx.index 用真实的 MaterialsIndex（走 mkdtemp + ZHANDAO_DATA_DIR），
// 这样 toolSearch/toolOutline/toolRead 走的是真代码，只有"模型说了什么"是假的。
// 形状与 qa/loop.test.ts 逐字对照——同一套材料、同一批断言场景，差别只在
// "怎么脚本化模型的话"（这里是 NativeTurn，不是一段 json 字符串）。

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

async function writeMaterial(id: string, title: string, body: string) {
  const materialsDir = resolve(testDataDir, "materials");
  await mkdir(materialsDir, { recursive: true });
  await writeFile(
    resolve(materialsDir, `${id}.md`),
    `---\nid: ${id}\ntitle: ${title}\nsource: https://example.com/${id}\n---\n\n${body}`,
  );
}

function toolCall(id: string, name: string, args: unknown): NativeToolCall {
  return { id, name, argsRaw: JSON.stringify(args) };
}

/** 脚本化的假 askOnceNative：按调用顺序依次返回给定的 NativeTurn，序列耗尽后抛错。 */
function scriptedAskOnceNative(turns: NativeTurn[]): {
  fn: (messages: unknown[], toolSchemas: unknown[]) => Promise<NativeTurn>;
  seenMessages: unknown[][];
} {
  let call = 0;
  const seenMessages: unknown[][] = [];
  const fn = async (messages: unknown[]): Promise<NativeTurn> => {
    seenMessages.push(messages);
    if (call >= turns.length) {
      throw new Error(`脚本序列耗尽（第 ${call + 1} 次调用，只写了 ${turns.length} 步）`);
    }
    const turn = turns[call];
    call += 1;
    if (turn === undefined) throw new Error("脚本内部错误");
    return turn;
  };
  return { fn, seenMessages };
}

/** 从一批消息里挑出所有 role:"tool" 消息，供断言"每个 tool_call 都回了一条"。 */
function toolMessagesOf(messages: unknown[]): { tool_call_id: string; content: string }[] {
  const result: { tool_call_id: string; content: string }[] = [];
  for (const m of messages) {
    if (
      typeof m === "object" &&
      m !== null &&
      "role" in m &&
      m.role === "tool" &&
      "tool_call_id" in m &&
      typeof m.tool_call_id === "string" &&
      "content" in m &&
      typeof m.content === "string"
    ) {
      result.push({ tool_call_id: m.tool_call_id, content: m.content });
    }
  }
  return result;
}

describe("qa/loop-native runAskNative", () => {
  let index: MaterialsIndex;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-qa-loop-native-test-"));
    process.env.ZHANDAO_DATA_DIR = testDataDir;

    await writeMaterial(
      "m1",
      "Undici 与本地代理",
      ["# Undici 与本地代理", "", "## 为什么 fetch 不读 http_proxy", "", "正文说 undici 不读环境变量，需要 EnvHttpProxyAgent。"].join(
        "\n",
      ),
    );

    index = await buildMaterialsIndex();
    ctx = { index };
  });

  afterEach(async () => {
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("正常路径：search → outline → read → 直接给最终文本，cites 来自真实 read 过的材料", async () => {
    const { fn } = scriptedAskOnceNative([
      { content: null, toolCalls: [toolCall("call_1", "search", { query: "undici 代理" })] },
      { content: null, toolCalls: [toolCall("call_2", "outline", { materialId: "m1" })] },
      { content: null, toolCalls: [toolCall("call_3", "read", { materialId: "m1", line: 2 })] },
      { content: "undici 不读 http_proxy，需要用 EnvHttpProxyAgent。", toolCalls: [] },
    ]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("undici 为什么不读代理？", deps);

    assert.strictEqual(result.rounds, 4);
    assert.strictEqual(result.hitLimit, false);
    assert.strictEqual(result.answer, "undici 不读 http_proxy，需要用 EnvHttpProxyAgent。");
    assert.deepStrictEqual(result.cites, ["m1"]);
    assert.deepStrictEqual(
      result.steps.map((s) => s.action.kind),
      ["search", "outline", "read", "answer"],
    );
  });

  test("一轮多个 tool_call：全部被执行，且每一个都在下一轮消息里收到对应的 role:tool 回执", async () => {
    const { fn, seenMessages } = scriptedAskOnceNative([
      // 第一轮：模型并行调用两个工具——这是 DeepSeek 的默认行为，不是特例
      {
        content: null,
        toolCalls: [
          toolCall("call_a", "search", { query: "undici" }),
          toolCall("call_b", "outline", { materialId: "m1" }),
        ],
      },
      { content: "库里没有更多可读的了", toolCalls: [] },
    ]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("随便问问", deps);

    // 两个 tool_call 各自产生一个 Step，且都记在同一个 round 里
    const round1Steps = result.steps.filter((s) => s.round === 1);
    assert.strictEqual(round1Steps.length, 2);
    assert.deepStrictEqual(
      round1Steps.map((s) => s.action.kind),
      ["search", "outline"],
    );

    // 关键断言：第二次调用 askOnceNative 时，历史里必须能看到两条 tool 消息，
    // tool_call_id 分别对应 call_a / call_b——少一条 API 就会 400（生产环境），
    // 这里用"历史里有没有对应消息"当作同样强度的断言。
    const secondCallMessages = seenMessages[1];
    assert.ok(secondCallMessages, "应当有第二次调用");
    const toolMsgs = toolMessagesOf(secondCallMessages ?? []);
    const ids = toolMsgs.map((m) => m.tool_call_id).sort();
    assert.deepStrictEqual(ids, ["call_a", "call_b"]);
  });

  test("引用完整性：没有 read 过任何材料时，即使给出文本答案也降级为 answer:null", async () => {
    const { fn } = scriptedAskOnceNative([
      // 只 search，没有 read——凭空给答案
      { content: null, toolCalls: [toolCall("call_1", "search", { query: "随便" })] },
      { content: "凭空的答案，没有真正读过任何材料", toolCalls: [] },
    ]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("问题", deps);

    assert.strictEqual(result.answer, null);
    assert.deepStrictEqual(result.cites, []);
  });

  test("引用完整性：真正 read 过的材料会出现在 cites 里，无需模型自己声明", async () => {
    const { fn } = scriptedAskOnceNative([
      { content: null, toolCalls: [toolCall("call_1", "read", { materialId: "m1", line: 2 })] },
      { content: "基于原文的答案", toolCalls: [] },
    ]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("问题", deps);

    assert.strictEqual(result.answer, "基于原文的答案");
    assert.deepStrictEqual(result.cites, ["m1"]);
  });

  test("触顶：模型一直调用 search 不给最终答案 → hitLimit=true，answer=null", async () => {
    const maxRounds = 3;
    const { fn } = scriptedAskOnceNative(
      Array.from({ length: maxRounds }, (_, i) => ({
        content: null,
        toolCalls: [toolCall(`call_${i}`, "search", { query: "随便搜点什么" })],
      })),
    );
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("问题", deps, { maxRounds });

    assert.strictEqual(result.hitLimit, true);
    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.rounds, maxRounds);
    assert.ok(result.steps.every((s) => s.action.kind === "search"));
  });

  test("最后一轮会被明确告知工具用完了", async () => {
    const seenLastMessage: string[] = [];
    const askOnceNative = async (messages: unknown[]): Promise<NativeTurn> => {
      const last = messages[messages.length - 1];
      const content =
        typeof last === "object" && last !== null && "content" in last && typeof last.content === "string"
          ? last.content
          : "";
      seenLastMessage.push(content);
      if (content.includes("这是最后一轮")) {
        return { content: "库里没有相关材料", toolCalls: [] };
      }
      return { content: null, toolCalls: [toolCall("call_x", "search", { query: "再试一次" })] };
    };
    const deps: AskNativeDeps = { ctx, askOnceNative };

    const result = await runAskNative("库里肯定没有的问题", deps, { maxRounds: 3 });

    assert.ok(seenLastMessage.some((m) => m.includes("这是最后一轮")));
    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.hitLimit, false, "应当是模型主动认输，不是沉默触顶");
  });

  test("参数形状不对：nativeCallToAction 抛出的 ProtocolError 被捕获为一个 step，并回一条 tool 消息而不中断循环", async () => {
    const { fn, seenMessages } = scriptedAskOnceNative([
      // read 的 line 给了字符串——参数形状不对
      { content: null, toolCalls: [toolCall("call_bad", "read", { materialId: "m1", line: "不是数字" })] },
      { content: "库里没有相关材料", toolCalls: [] },
    ]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn };

    const result = await runAskNative("问题", deps);

    assert.strictEqual(result.answer, null);
    assert.deepStrictEqual(
      result.steps.map((s) => s.action.kind),
      ["protocol_error", "answer"],
    );

    // 即使参数错了，也必须回一条 tool 消息给那个 tool_call_id，否则下一次 API 调用会 400
    const secondCallMessages = seenMessages[1];
    assert.ok(secondCallMessages);
    const toolMsgs = toolMessagesOf(secondCallMessages ?? []);
    assert.strictEqual(toolMsgs.length, 1);
    assert.strictEqual(toolMsgs[0]?.tool_call_id, "call_bad");
  });

  test("onStep 回调按顺序拿到每一轮的 Step", async () => {
    const seen: string[] = [];
    const { fn } = scriptedAskOnceNative([{ content: "库里没有", toolCalls: [] }]);
    const deps: AskNativeDeps = { ctx, askOnceNative: fn, onStep: (s) => seen.push(s.action.kind) };

    await runAskNative("问题", deps);

    assert.deepStrictEqual(seen, ["answer"]);
  });
});

describe("runAskNative：「找过了」与「没去找」不是一回事", () => {
  let dir: string;
  let c: ToolContext;

  beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "zhandao-native-outcome-"));
    process.env.ZHANDAO_DATA_DIR = dir;
    await writeMaterial("n1", "某篇材料", ["# 某篇材料", "", "## 小节", "", "正文。"].join("\n"));
    c = { index: await buildMaterialsIndex() };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.ZHANDAO_DATA_DIR;
  });

  test("一个工具都没调就给文本 → aborted（拿通用知识蒙的，不该记成收录信号）", async () => {
    const result = await runAskNative(
      "随便问",
      {
        ctx: c,
        askOnceNative: async () => ({ content: "我觉得答案是这样的……", toolCalls: [] }),
      },
      { maxRounds: 4 },
    );
    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.outcome, "aborted");
  });

  test("搜过但没读到可引用原文，然后给文本 → not_found（它确实去找了，这是收录信号）", async () => {
    let turn = 0;
    const result = await runAskNative(
      "库里没有的东西",
      {
        ctx: c,
        askOnceNative: async () => {
          turn += 1;
          if (turn === 1) {
            return {
              content: null,
              toolCalls: [{ id: "c1", name: "search", argsRaw: JSON.stringify({ query: "找不到的词" }) }],
            };
          }
          return { content: "库里没有相关材料。", toolCalls: [] };
        },
      },
      { maxRounds: 4 },
    );
    assert.strictEqual(result.answer, null);
    // 这一条是整个修复的判据：修之前它和上一条一样都是 aborted，于是收录信号在原生路径上消失
    assert.strictEqual(result.outcome, "not_found", "搜过了就算「找过」，read 不是唯一的找法");
  });
});
