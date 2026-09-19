import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { slugForAnchor, collectCandidateLines, buildDrills } from "./anchor.js";

describe("slugForAnchor", () => {
  test("去掉标题标记与自链接前缀，非字母数字中日韩字符替换成 -", () => {
    const slug = slugForAnchor("### [#](#get-和-post-有什么区别) GET 和 POST 有什么区别？");
    assert.strictEqual(slug, "GET-和-POST-有什么区别");
  });

  test("截断到 60 字符", () => {
    const longAnchor = "## " + "问".repeat(100);
    const slug = slugForAnchor(longAnchor);
    assert.ok(slug.length <= 60);
  });
});

describe("collectCandidateLines", () => {
  const markdown = [
    "# 标题", // 0：标题行
    "", // 1
    "正文一段，不是候选。", // 2
    "### [#](#get-和-post-有什么区别) GET 和 POST 有什么区别？", // 3：标题行
    "", // 4
    "GET 是幂等的，POST 不是。", // 5
    "", // 6
    "####   防抖函数   ", // 7：标题行（带首尾空白）
    "", // 8
    "**加粗的整行**", // 9：整行加粗行
    "", // 10
    "这一行**只是部分加粗**，不是整行加粗。", // 11：不该被收进候选集
  ].join("\n");

  test("收集全部标题行与整行加粗行，带 0-based 行号与原始文本", () => {
    const candidates = collectCandidateLines(markdown);
    const lines = candidates.map((c) => c.line);
    assert.deepStrictEqual(lines, [0, 3, 7, 9]);
  });

  test("text 是该行原始文本，不 trim", () => {
    const candidates = collectCandidateLines(markdown);
    const heading = candidates.find((c) => c.line === 7);
    assert.ok(heading);
    assert.strictEqual(heading.text, "####   防抖函数   ");
  });

  test("部分加粗（非整行）不算候选", () => {
    const candidates = collectCandidateLines(markdown);
    assert.ok(!candidates.some((c) => c.line === 11));
  });

  test("空文档返回空数组", () => {
    assert.deepStrictEqual(collectCandidateLines(""), []);
  });
});

describe("buildDrills", () => {
  const markdown = [
    "### 问题一：什么是闭包？", // 0
    "", // 1
    "闭包是……", // 2
    "### 问题二：什么是原型链？", // 3
    "", // 4
    "原型链是……", // 5
  ].join("\n");

  test("line 不在候选集里的整条丢弃——机械不变量", () => {
    const drills = buildDrills("mat1", markdown, [
      { line: 0, question: "什么是闭包？" },
      { line: 2, question: "编造的问题，2 不是候选行（是正文段落）" },
    ]);
    assert.strictEqual(drills.length, 1);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.question, "什么是闭包？");
  });

  test("question 为空串的整条丢弃", () => {
    const drills = buildDrills("mat1", markdown, [{ line: 0, question: "" }]);
    assert.strictEqual(drills.length, 0);
  });

  test("anchor 逐字等于正文里那一行，而不是模型给出的任何文本", () => {
    // question 与该行文字完全不同，anchor 仍必须是候选集里查到的原文
    const drills = buildDrills("mat1", markdown, [
      { line: 0, question: "随便写点什么，与原文毫不相干" },
    ]);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.anchor, "### 问题一：什么是闭包？");
  });

  test("保持模型给出的顺序", () => {
    const drills = buildDrills("mat1", markdown, [
      { line: 3, question: "什么是原型链？" },
      { line: 0, question: "什么是闭包？" },
    ]);
    const [first, second] = drills;
    assert.ok(first && second);
    assert.strictEqual(first.question, "什么是原型链？");
    assert.strictEqual(second.question, "什么是闭包？");
  });

  test("id 是材料 id 与锚点 slug 拼出的确定值，且记下正确的 anchorLine", () => {
    const drills = buildDrills("mat1", markdown, [{ line: 0, question: "什么是闭包？" }]);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.id, `mat1#${slugForAnchor("### 问题一：什么是闭包？")}`);
    assert.strictEqual(first.anchorLine, 0);
  });

  test("slug 冲突时追加 -2 / -3，id 不重复", () => {
    // 两个措辞不同但 slug 化后相同的标题（空格 vs 连字符都会被归一化成 -），
    // 这是 buildDrills 里 slug 冲突分支唯一会被触发的场景
    const md = ["## 面试题 A", "内容一", "## 面试题-A", "内容二"].join("\n");
    const drills = buildDrills("mat3", md, [
      { line: 0, question: "第一题" },
      { line: 2, question: "第二题" },
    ]);
    assert.strictEqual(drills.length, 2);
    const ids = drills.map((d) => d.id);
    assert.strictEqual(new Set(ids).size, 2, "两条记录的 id 必须不同");
    const [, second] = ids;
    assert.ok(second);
    assert.ok(second.endsWith("-2"), `冲突时第二条应追加 -2，实际是 ${second}`);
  });
});
