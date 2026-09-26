import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { askOnceNative, NativeCallFailed } from "./answer-native.js";
import { MissingApiKey } from "./keywords.js";

// 形状照抄 model/answer.test.ts：覆盖 globalThis.fetch，绝不真的调 DeepSeek。

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

interface FakeToolCall {
  id: string;
  name: string;
  argsRaw: string;
}

function completionBody(opts: {
  content?: string | null;
  toolCalls?: FakeToolCall[];
  finishReason?: string;
}): string {
  const { content = null, toolCalls = [], finishReason = "stop" } = opts;
  return JSON.stringify({
    id: "test-completion",
    object: "chat.completion",
    created: 0,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls:
            toolCalls.length > 0
              ? toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: tc.argsRaw },
                }))
              : undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: content?.length ?? 0, total_tokens: 10 },
  });
}

function stubFetchSequence(bodies: string[]): { callCount: () => number } {
  let calls = 0;
  const impl: typeof fetch = async () => {
    const idx = Math.min(calls, bodies.length - 1);
    const body = bodies[idx] ?? completionBody({});
    calls += 1;
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  globalThis.fetch = impl;
  return { callCount: () => calls };
}

const sampleMessages: unknown[] = [
  { role: "system", content: "你是一个原生 tool_calls 驱动的问答 agent。" },
  { role: "user", content: "undici 为什么不读代理？" },
];

const sampleTools: unknown[] = [
  {
    type: "function",
    function: {
      name: "search",
      description: "检索材料",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
];

describe("askOnceNative", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
  });

  test("正常返回纯文本，没有 tool_calls", async () => {
    stubFetchSequence([completionBody({ content: "这是最终答案" })]);

    const turn = await askOnceNative(sampleMessages, sampleTools);

    assert.strictEqual(turn.content, "这是最终答案");
    assert.deepStrictEqual(turn.toolCalls, []);
  });

  test("返回 tool_calls 时 content 可以是 null，toolCalls 被正确抽出", async () => {
    stubFetchSequence([
      completionBody({
        content: null,
        toolCalls: [
          { id: "call_1", name: "search", argsRaw: '{"query":"undici 代理"}' },
          { id: "call_2", name: "outline", argsRaw: '{"materialId":"m1"}' },
        ],
        finishReason: "tool_calls",
      }),
    ]);

    const turn = await askOnceNative(sampleMessages, sampleTools);

    assert.strictEqual(turn.content, null);
    assert.deepStrictEqual(turn.toolCalls, [
      { id: "call_1", name: "search", argsRaw: '{"query":"undici 代理"}' },
      { id: "call_2", name: "outline", argsRaw: '{"materialId":"m1"}' },
    ]);
  });

  test("空内容且无 tool_calls 时重试一次，第二次成功", async () => {
    const stub = stubFetchSequence([
      completionBody({ content: null }),
      completionBody({ content: "重试后的答案" }),
    ]);

    const turn = await askOnceNative(sampleMessages, sampleTools);

    assert.strictEqual(turn.content, "重试后的答案");
    assert.strictEqual(stub.callCount(), 2);
  });

  test("两次都空（无 content 无 tool_calls）则抛 NativeCallFailed，消息带 finish_reason 和 token 数", async () => {
    const impl: typeof fetch = async () =>
      new Response(completionBody({ content: null, finishReason: "length" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = impl;

    await assert.rejects(
      () => askOnceNative(sampleMessages, sampleTools),
      (err: unknown) => {
        assert.ok(err instanceof NativeCallFailed);
        assert.ok(err.message.includes("finish_reason=length"));
        assert.ok(err.message.includes("tokens"));
        return true;
      },
    );
  });

  test("缺少 DEEPSEEK_API_KEY 时抛 MissingApiKey", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stubFetchSequence([completionBody({ content: "x" })]);

    await assert.rejects(() => askOnceNative(sampleMessages, sampleTools), MissingApiKey);
  });

  test("messages 形状不对（内部契约被打破）时抛 NativeCallFailed，且不发起任何请求", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(completionBody({ content: "不该被用到" }));
    };

    const badMessages: unknown[] = [{ role: "banana", content: "坏消息" }];

    await assert.rejects(() => askOnceNative(badMessages, sampleTools), NativeCallFailed);
    assert.strictEqual(fetchCalled, false, "形状校验应当在发起网络请求之前失败");
  });

  test("toolSchemas 形状不对时抛 NativeCallFailed，且不发起任何请求", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(completionBody({ content: "不该被用到" }));
    };

    const badTools: unknown[] = [{ type: "function", function: { name: "search" } }]; // 缺 description/parameters

    await assert.rejects(() => askOnceNative(sampleMessages, badTools), NativeCallFailed);
    assert.strictEqual(fetchCalled, false, "形状校验应当在发起网络请求之前失败");
  });
});
