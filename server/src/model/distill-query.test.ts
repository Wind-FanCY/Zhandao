import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { distillQuery, QueryDistillFailed } from "./distill-query.js";
import { MissingApiKey } from "./keywords.js";

// 照 extract.test.ts 的 stubFetch 套路：这个目录（model/）没有 keywords.test.ts 可抄，
// 所以直接抄 inbox/extract.test.ts 的做法——覆盖 globalThis.fetch。
// OpenAI 客户端在 `new OpenAI(...)` 时读一次 `fetch`（裸标识符，解析到当时的 globalThis.fetch），
// 而 distillQuery 每次调用都新建客户端，所以在调用前换掉 globalThis.fetch 就够了。

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

/** 构造一条合法的 DeepSeek chat completion 响应体 */
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

/**
 * 依次返回给定的 content 序列（每次调用取下一个，用完后重复最后一个）。
 * 不用 `as` 断言：直接实现一个签名与 `typeof fetch` 一致的函数并整体赋值。
 */
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

describe("distillQuery", () => {
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

  test("正常返回：解析出 query 字段", async () => {
    stubFetchSequence([JSON.stringify({ query: "undici http_proxy 代理" })]);

    const query = await distillQuery(
      "undici 不读 http_proxy 这个环境变量，得用代码内 setGlobalDispatcher",
    );

    assert.strictEqual(query, "undici http_proxy 代理");
  });

  test("空内容重试一次后成功", async () => {
    const stub = stubFetchSequence([
      "", // 第一次：空内容（DeepSeek 文档明示可能发生）
      JSON.stringify({ query: "compression SSE res.flush" }),
    ]);

    const query = await distillQuery("compression 会累积输出，SSE 连接长期不结束");

    assert.strictEqual(query, "compression SSE res.flush");
    assert.strictEqual(stub.callCount(), 2);
  });

  test("两次都空内容则抛 QueryDistillFailed", async () => {
    stubFetchSequence(["", ""]);

    await assert.rejects(() => distillQuery("怎么都提炼不出来的一句话"), QueryDistillFailed);
  });

  test("返回的 JSON 形状不对（缺 query 字段）时 zod 拦住并最终抛错", async () => {
    stubFetchSequence([
      JSON.stringify({ keywords: ["不是", "query", "字段"] }),
      JSON.stringify({ keywords: ["还是", "不对"] }),
    ]);

    await assert.rejects(() => distillQuery("形状不对的响应"), QueryDistillFailed);
  });

  test("缺少 DEEPSEEK_API_KEY 时抛 MissingApiKey", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stubFetchSequence([JSON.stringify({ query: "不会被用到" })]);

    await assert.rejects(() => distillQuery("随便一句话"), MissingApiKey);
  });
});
