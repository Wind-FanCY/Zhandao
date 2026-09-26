import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { askOnce, AnswerCallFailed, type ChatMessage } from "./answer.js";
import { MissingApiKey } from "./keywords.js";

// 形状照抄 model/extract-drills.test.ts：覆盖 globalThis.fetch，绝不真的调 DeepSeek。

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

function completionBody(content: string | null, finishReason = "stop"): string {
  return JSON.stringify({
    id: "test-completion",
    object: "chat.completion",
    created: 0,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: content?.length ?? 0, total_tokens: 10 },
  });
}

function stubFetchSequence(contents: (string | null)[]): { callCount: () => number } {
  let calls = 0;
  const impl: typeof fetch = async () => {
    const idx = Math.min(calls, contents.length - 1);
    const content = contents[idx] ?? null;
    calls += 1;
    return new Response(completionBody(content), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  globalThis.fetch = impl;
  return { callCount: () => calls };
}

const sampleMessages: ChatMessage[] = [
  { role: "system", content: "你是一个协议驱动的问答 agent。" },
  { role: "user", content: "undici 为什么不读代理？" },
];

describe("askOnce", () => {
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

  test("正常返回原始 content 字符串，不做任何 JSON 解析", async () => {
    const raw = JSON.stringify({ kind: "none", reason: "测试" });
    stubFetchSequence([raw]);

    const content = await askOnce(sampleMessages);

    // askOnce 只负责转发，不解析——返回值必须逐字等于模型给的 content
    assert.strictEqual(content, raw);
  });

  test("messages 原样转发给模型（不会被 askOnce 篡改）", async () => {
    let capturedBody: unknown;
    // 用 `: typeof fetch` 的上下文类型标注而不是 `as typeof fetch` 断言——
    // 前者让 TS 自己推导 _input/init 的形参类型，后者是"告诉编译器相信我"。
    const impl: typeof fetch = async (_input, init) => {
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      capturedBody = rawBody !== undefined ? JSON.parse(rawBody) : undefined;
      return new Response(completionBody(JSON.stringify({ kind: "none", reason: "x" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    globalThis.fetch = impl;

    await askOnce(sampleMessages);

    assert.ok(capturedBody !== undefined && typeof capturedBody === "object" && capturedBody !== null);
    assert.ok(capturedBody !== null && "messages" in capturedBody);
    if (capturedBody !== null && typeof capturedBody === "object" && "messages" in capturedBody) {
      assert.deepStrictEqual(capturedBody.messages, sampleMessages);
    }
  });

  test("空内容重试一次后成功", async () => {
    const raw = JSON.stringify({ kind: "search", query: "x" });
    const stub = stubFetchSequence(["", raw]);

    const content = await askOnce(sampleMessages);

    assert.strictEqual(content, raw);
    assert.strictEqual(stub.callCount(), 2);
  });

  test("两次都空内容则抛 AnswerCallFailed，消息带 finish_reason 和 token 数", async () => {
    const impl: typeof fetch = async () =>
      new Response(completionBody(null, "length"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = impl;

    await assert.rejects(
      () => askOnce(sampleMessages),
      (err: unknown) => {
        assert.ok(err instanceof AnswerCallFailed);
        assert.ok(err.message.includes("finish_reason=length"));
        assert.ok(err.message.includes("tokens"));
        return true;
      },
    );
  });

  test("缺少 DEEPSEEK_API_KEY 时抛 MissingApiKey", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stubFetchSequence([JSON.stringify({ kind: "none", reason: "x" })]);

    await assert.rejects(() => askOnce(sampleMessages), MissingApiKey);
  });
});
