import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildMaterialsIndex, type MaterialsIndex } from "../search/materials-index.js";
import { runAsk, type AskDeps } from "./loop.js";
import type { ToolContext } from "./tools.js";
import type { ChatMessage } from "../model/answer.js";

// runAsk 绝不真的调模型——askOnce 全部是注入的假实现，脚本化返回值。
// ctx.index 用真实的 MaterialsIndex（走 mkdtemp + ZHANDAO_DATA_DIR，绝不碰真实 ../data），
// 这样 toolSearch/toolOutline/toolRead 走的是真代码，只有"模型说了什么"是假的。

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

/** 脚本化的假 askOnce：按调用顺序依次返回给定的动作对象，序列耗尽后抛错（说明脚本没写够）。 */
function scriptedAskOnce(actions: unknown[]): (messages: ChatMessage[]) => Promise<string> {
  let call = 0;
  return async () => {
    if (call >= actions.length) {
      throw new Error(`脚本序列耗尽（第 ${call + 1} 次调用，只写了 ${actions.length} 步）`);
    }
    const action = actions[call];
    call += 1;
    return JSON.stringify(action);
  };
}

describe("qa/loop runAsk", () => {
  let index: MaterialsIndex;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-qa-loop-test-"));
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

  test("正常路径：search → outline → read → answer，steps 顺序与 cites 正确", async () => {
    const deps: AskDeps = {
      ctx,
      askOnce: scriptedAskOnce([
        { kind: "search", query: "undici 代理" },
        { kind: "outline", materialId: "m1" },
        { kind: "read", materialId: "m1", line: 2 },
        { kind: "answer", text: "undici 不读 http_proxy，需要用 EnvHttpProxyAgent。", cites: ["m1"] },
      ]),
    };

    const result = await runAsk("undici 为什么不读代理？", deps);

    assert.strictEqual(result.rounds, 4);
    assert.strictEqual(result.hitLimit, false);
    assert.strictEqual(result.answer, "undici 不读 http_proxy，需要用 EnvHttpProxyAgent。");
    assert.deepStrictEqual(result.cites, ["m1"]);
    assert.deepStrictEqual(
      result.steps.map((s) => s.action.kind),
      ["search", "outline", "read", "answer"],
    );
  });

  test("引用完整性：cites 引用了没读过的材料 id 时那条被剔除", async () => {
    const deps: AskDeps = {
      ctx,
      askOnce: scriptedAskOnce([
        { kind: "read", materialId: "m1", line: 2 },
        { kind: "answer", text: "答案", cites: ["m1", "m2-从未被-read-过"] },
      ]),
    };

    const result = await runAsk("问题", deps);

    assert.strictEqual(result.answer, "答案");
    assert.deepStrictEqual(result.cites, ["m1"]); // 未读过的那个 id 被剔除
  });

  test("引用完整性：全部引用都无效时整体降级为 answer: null", async () => {
    const deps: AskDeps = {
      ctx,
      // 没有任何成功的 read，直接给答案——cites 里的 m1 从未被真正读过
      askOnce: scriptedAskOnce([{ kind: "answer", text: "凭空的答案", cites: ["m1"] }]),
    };

    const result = await runAsk("问题", deps);

    assert.strictEqual(result.answer, null);
    assert.deepStrictEqual(result.cites, []);
  });

  test("库里没有：假模型只返回 none → answer === null，steps 有记录", async () => {
    const deps: AskDeps = {
      ctx,
      askOnce: scriptedAskOnce([{ kind: "none", reason: "库里没有这方面的材料" }]),
    };

    const result = await runAsk("一个库里没有答案的问题", deps);

    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.hitLimit, false);
    assert.strictEqual(result.rounds, 1);
    assert.strictEqual(result.steps.length, 1);
    assert.strictEqual(result.steps[0]?.action.kind, "none");
  });

  test("触顶：假模型永远返回 search → hitLimit === true，answer === null，rounds === maxRounds", async () => {
    const maxRounds = 3;
    const deps: AskDeps = {
      ctx,
      askOnce: scriptedAskOnce(
        Array.from({ length: maxRounds }, () => ({ kind: "search", query: "随便搜点什么" })),
      ),
    };

    const result = await runAsk("问题", deps, { maxRounds });

    assert.strictEqual(result.hitLimit, true);
    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.rounds, maxRounds);
    assert.strictEqual(result.steps.length, maxRounds);
    assert.ok(result.steps.every((s) => s.action.kind === "search"));
  });

  test("协议错误恢复：第一次返回垃圾文本，之后恢复正常并最终给出有效答案", async () => {
    let call = 0;
    const askOnce = async (): Promise<string> => {
      call += 1;
      if (call === 1) return "这不是 json，模型输出了一段多余的话";
      if (call === 2) return JSON.stringify({ kind: "read", materialId: "m1", line: 2 });
      return JSON.stringify({ kind: "answer", text: "恢复之后的答案", cites: ["m1"] });
    };

    const deps: AskDeps = { ctx, askOnce };

    const result = await runAsk("问题", deps);

    assert.strictEqual(result.answer, "恢复之后的答案");
    assert.deepStrictEqual(result.cites, ["m1"]);
    assert.strictEqual(result.rounds, 3);
    // 第一轮是协议错误，不是模型自己声明的 none——但循环体拿协议错误当一次
    // 「未能解析出合法动作」的记录处理，resultSummary 里能看到这个事实
    assert.ok(result.steps[0]?.resultSummary.includes("不是合法的动作"));
  });

  test("连续两次协议错误就放弃，不再无限重试", async () => {
    // 两次返回都不是合法 JSON，不能用 scriptedAskOnce（那个工具期望传对象后 JSON.stringify）,
    // 直接写一个普通异步函数、用闭包变量数调用次数。
    let call = 0;
    const deps: AskDeps = {
      ctx,
      askOnce: async () => {
        call += 1;
        return call === 1 ? "垃圾文本一" : "垃圾文本二，还是不是 json";
      },
    };

    const result = await runAsk("问题", deps);

    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.hitLimit, false);
    assert.strictEqual(result.rounds, 2);
    assert.strictEqual(call, 2, "连续两次协议错误后不应再调用第三次");
  });

  test("onStep 回调按顺序拿到每一轮的 Step", async () => {
    const seen: string[] = [];
    const deps: AskDeps = {
      ctx,
      askOnce: scriptedAskOnce([{ kind: "none", reason: "没有" }]),
      onStep: (s) => seen.push(s.action.kind),
    };

    await runAsk("问题", deps);

    assert.deepStrictEqual(seen, ["none"]);
  });
});

describe("runAsk：步骤流的语义分界（实测逼出来的两条）", () => {
  let localDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    localDir = await mkdtemp(resolve(tmpdir(), "zhandao-qa-loop-sem-"));
    process.env.ZHANDAO_DATA_DIR = localDir;
    await writeMaterial("s1", "随便一篇", ["# 随便一篇", "", "## 小节", "", "正文。"].join("\n"));
    ctx = { index: await buildMaterialsIndex() };
  });

  afterEach(async () => {
    await rm(localDir, { recursive: true, force: true });
    delete process.env.ZHANDAO_DATA_DIR;
  });

  test("协议错误不得伪装成 none——那会让界面把「模型乱码」显示成「库里没有」", async () => {
    // 第一次吐垃圾，第二次正常收场
    const replies = ["这不是 json", JSON.stringify({ kind: "none", reason: "库里确实没有" })];
    let i = 0;
    const result = await runAsk(
      "随便问问",
      { ctx, askOnce: async () => replies[Math.min(i++, replies.length - 1)] ?? "" },
      { maxRounds: 4 },
    );

    const kinds = result.steps.map((s) => s.action.kind);
    assert.ok(kinds.includes("protocol_error"), `步骤流里应当出现 protocol_error，实际是 ${kinds.join(",")}`);

    // 关键断言：第一步是格式错，**不是** none
    const first = result.steps[0];
    assert.ok(first);
    assert.strictEqual(first.action.kind, "protocol_error");
    assert.notStrictEqual(first.action.kind, "none");
  });

  test("最后一轮会被明确告知工具用完了——库外问题应当以 none 收场而不是沉默触顶", async () => {
    const seen: string[] = [];
    const result = await runAsk(
      "库里肯定没有的问题",
      {
        ctx,
        askOnce: async (messages) => {
          const last = messages[messages.length - 1];
          seen.push(last?.content ?? "");
          // 只有被告知"最后一轮"时才肯认输——刻意模仿实测到的模型行为
          if ((last?.content ?? "").includes("这是最后一轮")) {
            return JSON.stringify({ kind: "none", reason: "库里没有相关材料" });
          }
          return JSON.stringify({ kind: "search", query: "再试一次" });
        },
      },
      { maxRounds: 3 },
    );

    assert.ok(
      seen.some((m) => m.includes("这是最后一轮")),
      "最后一轮必须先告诉模型工具已经没了",
    );
    assert.strictEqual(result.answer, null);
    // 以 none 收场，而不是触顶——这是这条改动的全部意义
    assert.strictEqual(result.hitLimit, false, "应当是模型主动认输，不是沉默触顶");
    assert.strictEqual(result.steps[result.steps.length - 1]?.action.kind, "none");
  });
});
