import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { extractDrills, DrillExtractFailed } from "./extract-drills.js";
import { MissingApiKey } from "./keywords.js";

// 形状照抄 model/distill-query.test.ts：覆盖 globalThis.fetch，不真的调 DeepSeek。

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

function completionBody(content: string | null): string {
  return JSON.stringify({
    id: "test-completion",
    object: "chat.completion",
    created: 0,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
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

const sampleCandidates = [{ line: 0, text: "### 什么是闭包？" }];

describe("extractDrills", () => {
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

  test("正常返回：解析出 drills 数组", async () => {
    stubFetchSequence([JSON.stringify({ drills: [{ line: 0, question: "什么是闭包？" }] })]);

    const drills = await extractDrills(sampleCandidates);

    assert.strictEqual(drills.length, 1);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.question, "什么是闭包？");
    assert.strictEqual(first.line, 0);
  });

  test("候选集为空时不调用模型，直接返回空数组", async () => {
    const stub = stubFetchSequence([JSON.stringify({ drills: [] })]);

    const drills = await extractDrills([]);

    assert.deepStrictEqual(drills, []);
    assert.strictEqual(stub.callCount(), 0, "候选集为空不该调模型");
  });

  test("空数组是合法返回值，不触发重试/失败", async () => {
    const stub = stubFetchSequence([JSON.stringify({ drills: [] })]);

    const drills = await extractDrills(sampleCandidates);

    assert.deepStrictEqual(drills, []);
    assert.strictEqual(stub.callCount(), 1, "空数组不该触发第二次调用");
  });

  test("空内容重试一次后成功", async () => {
    const stub = stubFetchSequence(["", JSON.stringify({ drills: [{ line: 0, question: "Q" }] })]);

    const drills = await extractDrills([{ line: 0, text: "## Q" }]);

    assert.strictEqual(drills.length, 1);
    assert.strictEqual(stub.callCount(), 2);
  });

  test("两次都空内容则抛 DrillExtractFailed", async () => {
    stubFetchSequence(["", ""]);

    await assert.rejects(() => extractDrills(sampleCandidates), DrillExtractFailed);
  });

  test("返回的 JSON 形状不对时 zod 拦住并最终抛错", async () => {
    stubFetchSequence([
      JSON.stringify({ keywords: ["不是", "drills", "字段"] }),
      JSON.stringify({ notDrills: [] }),
    ]);

    await assert.rejects(() => extractDrills(sampleCandidates), DrillExtractFailed);
  });

  test("line 不是数字时 zod 拦住并最终抛错（模型编造了非法行号形状）", async () => {
    stubFetchSequence([JSON.stringify({ drills: [{ line: "第一行", question: "Q" }] })]);

    await assert.rejects(() => extractDrills(sampleCandidates), DrillExtractFailed);
  });

  test("缺少 DEEPSEEK_API_KEY 时抛 MissingApiKey", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stubFetchSequence([JSON.stringify({ drills: [] })]);

    await assert.rejects(() => extractDrills(sampleCandidates), MissingApiKey);
  });
});
