import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { PROTOCOL_PROMPT, parseAction, renderToolResult, ProtocolError } from "./protocol.js";

describe("PROTOCOL_PROMPT", () => {
  test("含 json 字样（DeepSeek JSON 模式硬性要求）", () => {
    assert.ok(PROTOCOL_PROMPT.includes("json"));
  });

  test("显式要求答案只能来自读到的原文、没把握就 none", () => {
    // 不断言逐字匹配（措辞可能调整），只断言这两条硬性规则的关键词都在
    assert.ok(PROTOCOL_PROMPT.includes("read"));
    assert.ok(PROTOCOL_PROMPT.includes("none"));
    assert.ok(PROTOCOL_PROMPT.includes("通用知识"));
  });
});

describe("parseAction", () => {
  test("正确解析 search 动作", () => {
    const action = parseAction(JSON.stringify({ kind: "search", query: "undici 代理" }));
    assert.deepStrictEqual(action, { kind: "search", query: "undici 代理" });
  });

  test("正确解析 outline 动作", () => {
    const action = parseAction(JSON.stringify({ kind: "outline", materialId: "m1" }));
    assert.deepStrictEqual(action, { kind: "outline", materialId: "m1" });
  });

  test("正确解析 read 动作", () => {
    const action = parseAction(JSON.stringify({ kind: "read", materialId: "m1", line: 3 }));
    assert.deepStrictEqual(action, { kind: "read", materialId: "m1", line: 3 });
  });

  test("正确解析 answer 动作", () => {
    const action = parseAction(JSON.stringify({ kind: "answer", text: "答案", cites: ["m1", "m2"] }));
    assert.deepStrictEqual(action, { kind: "answer", text: "答案", cites: ["m1", "m2"] });
  });

  test("正确解析 none 动作", () => {
    const action = parseAction(JSON.stringify({ kind: "none", reason: "库里没有" }));
    assert.deepStrictEqual(action, { kind: "none", reason: "库里没有" });
  });

  test("不是合法 JSON 时抛 ProtocolError", () => {
    assert.throws(() => parseAction("这不是 json，模型多话了"), ProtocolError);
  });

  test("kind 拼错时抛 ProtocolError", () => {
    assert.throws(() => parseAction(JSON.stringify({ kind: "serach", query: "x" })), ProtocolError);
  });

  test("缺字段时抛 ProtocolError", () => {
    assert.throws(() => parseAction(JSON.stringify({ kind: "read", materialId: "m1" })), ProtocolError);
  });

  test("line 不是数字时抛 ProtocolError（模型把行号写成了字符串）", () => {
    assert.throws(
      () => parseAction(JSON.stringify({ kind: "read", materialId: "m1", line: "3" })),
      ProtocolError,
    );
  });

  test("cites 不是数组时抛 ProtocolError", () => {
    assert.throws(
      () => parseAction(JSON.stringify({ kind: "answer", text: "答案", cites: "m1" })),
      ProtocolError,
    );
  });

  test("顶层不是对象（比如裸数组）时抛 ProtocolError", () => {
    assert.throws(() => parseAction(JSON.stringify(["search", "x"])), ProtocolError);
  });
});

describe("renderToolResult", () => {
  test("search：正常结果列出 materialId / 标题 / from / score", () => {
    const text = renderToolResult(
      { kind: "search", query: "q" },
      [{ materialId: "m1", title: "标题一", from: "https://example.com/index", score: 1.23 }],
    );
    assert.ok(text.includes("m1"));
    assert.ok(text.includes("标题一"));
    assert.ok(text.includes("https://example.com/index"));
    assert.ok(text.includes("1.23"));
  });

  test("search：空数组给出明确的\"没搜到\"提示", () => {
    const text = renderToolResult({ kind: "search", query: "q" }, []);
    assert.ok(text.includes("没有搜到"));
  });

  test("search：结果不是数组时不抛错，降级为提示文本", () => {
    const text = renderToolResult({ kind: "search", query: "q" }, "不是数组");
    assert.ok(text.includes("没有搜到"));
  });

  test("outline：null 结果提示材料不存在", () => {
    const text = renderToolResult({ kind: "outline", materialId: "m1" }, null);
    assert.ok(text.includes("不存在"));
  });

  test("outline：entries 为空时提示没有候选行", () => {
    const text = renderToolResult({ kind: "outline", materialId: "m1" }, { title: "标题", entries: [] });
    assert.ok(text.includes("没有可展开的候选行"));
  });

  test("outline：正常结果带行号与文本", () => {
    const text = renderToolResult(
      { kind: "outline", materialId: "m1" },
      { title: "标题", entries: [{ line: 2, text: "## 子标题" }] },
    );
    assert.ok(text.includes("L2"));
    assert.ok(text.includes("## 子标题"));
  });

  test("read：null 结果提示读不到", () => {
    const text = renderToolResult({ kind: "read", materialId: "m1", line: 0 }, null);
    assert.ok(text.includes("读不到"));
  });

  test("read：正常结果带标题与原文", () => {
    const text = renderToolResult(
      { kind: "read", materialId: "m1", line: 0 },
      { title: "标题", text: "这是原文" },
    );
    assert.ok(text.includes("标题"));
    assert.ok(text.includes("这是原文"));
  });

  test("answer / none 是终态，不会被真正渲染成工具结果——返回空字符串", () => {
    assert.strictEqual(renderToolResult({ kind: "answer", text: "x", cites: [] }, null), "");
    assert.strictEqual(renderToolResult({ kind: "none", reason: "x" }, null), "");
  });
});
