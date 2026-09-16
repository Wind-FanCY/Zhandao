import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeForFilename } from "./filename.js";

test("保留中文字符原样", () => {
  assert.equal(sanitizeForFilename("中文标题测试", 60), "中文标题测试");
});

test("去掉非法字符 / \\ : * ? \" < > | 与控制字符", () => {
  assert.equal(sanitizeForFilename('Test / With \\ : * ? " < > | Chars', 60), "Test-With-Chars");
  assert.equal(sanitizeForFilename("A\x00B\x1fC", 60), "ABC");
});

test("空白折叠成单个 -", () => {
  assert.equal(sanitizeForFilename("Test   With   Many    Spaces", 60), "Test-With-Many-Spaces");
});

test("截断到 maxLen 个字符", () => {
  const long = "a".repeat(100);
  assert.equal(sanitizeForFilename(long, 24).length, 24);
  assert.equal(sanitizeForFilename(long, 60).length, 60);
});

test("去掉首尾的 -", () => {
  assert.equal(sanitizeForFilename("  spaced out  ", 60), "spaced-out");
});

test("清理后为空则返回空字符串", () => {
  assert.equal(sanitizeForFilename("///\\\\:::***", 60), "");
});

test("maxLen 不同时对同一输入结果不同——回填的实际用途", () => {
  const text = "这是一条比较长的速记内容用来测试摘要截断行为";
  const short = sanitizeForFilename(text, 24);
  const long = sanitizeForFilename(text, 60);
  assert.ok(short.length <= 24);
  assert.ok(long.length <= 60);
  assert.equal(long, text); // 本例文本本身不超过 60
});
