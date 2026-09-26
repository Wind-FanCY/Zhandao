import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { TOOL_SCHEMAS, NATIVE_SYSTEM_PROMPT, nativeCallToAction } from "./protocol-native.js";
import { ProtocolError } from "./protocol.js";
import type { NativeToolCall } from "../model/answer-native.js";

describe("TOOL_SCHEMAS", () => {
  test("三个工具，名字与 search/outline/read 一一对应", () => {
    const names = TOOL_SCHEMAS.map((t) => {
      if (typeof t !== "object" || t === null || !("function" in t)) return undefined;
      const fn = t.function;
      if (typeof fn !== "object" || fn === null || !("name" in fn)) return undefined;
      return fn.name;
    });
    assert.deepStrictEqual(names, ["search", "outline", "read"]);
  });
});

describe("NATIVE_SYSTEM_PROMPT", () => {
  test("硬性规则仍在：答案只能来自 read、没把握就说库里没有、不许拿通用知识硬凑", () => {
    assert.ok(NATIVE_SYSTEM_PROMPT.includes("read"));
    assert.ok(NATIVE_SYSTEM_PROMPT.includes("通用知识"));
    assert.ok(NATIVE_SYSTEM_PROMPT.includes("库里没有"));
  });

  test("不再讲 json 格式——原生协议不需要手搓协议那套「五选一」说明", () => {
    assert.ok(!NATIVE_SYSTEM_PROMPT.includes("json"));
    assert.ok(!NATIVE_SYSTEM_PROMPT.includes("五选一"));
  });
});

function call(name: string, args: unknown): NativeToolCall {
  return { id: "call_1", name, argsRaw: JSON.stringify(args) };
}

describe("nativeCallToAction", () => {
  test("正确转换 search 调用", () => {
    const action = nativeCallToAction(call("search", { query: "undici 代理" }));
    assert.deepStrictEqual(action, { kind: "search", query: "undici 代理" });
  });

  test("正确转换 outline 调用", () => {
    const action = nativeCallToAction(call("outline", { materialId: "m1" }));
    assert.deepStrictEqual(action, { kind: "outline", materialId: "m1" });
  });

  test("正确转换 read 调用", () => {
    const action = nativeCallToAction(call("read", { materialId: "m1", line: 3 }));
    assert.deepStrictEqual(action, { kind: "read", materialId: "m1", line: 3 });
  });

  test("argsRaw 不是合法 JSON 时抛 ProtocolError", () => {
    const bad: NativeToolCall = { id: "call_1", name: "search", argsRaw: "这不是 json" };
    assert.throws(() => nativeCallToAction(bad), ProtocolError);
  });

  test("search 缺 query 字段时抛 ProtocolError", () => {
    assert.throws(() => nativeCallToAction(call("search", {})), ProtocolError);
  });

  test("read 的 line 是字符串（模型没按 schema 给类型）时抛 ProtocolError", () => {
    // DeepSeek「没有严格 JSON Schema」——parameters 只是提示，模型完全可能给出
    // 类型不对的值（这里 line 应该是 integer，模型给了字符串）
    assert.throws(() => nativeCallToAction(call("read", { materialId: "m1", line: "3" })), ProtocolError);
  });

  test("read 缺 materialId 字段时抛 ProtocolError", () => {
    assert.throws(() => nativeCallToAction(call("read", { line: 3 })), ProtocolError);
  });

  test("调用了未知工具名时抛 ProtocolError", () => {
    assert.throws(() => nativeCallToAction(call("delete_everything", {})), ProtocolError);
  });
});
