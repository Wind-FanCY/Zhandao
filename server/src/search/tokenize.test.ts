import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { tokenize } from "./tokenize.js";

describe("tokenize", () => {
  test("纯英文句子转小写词项", () => {
    const tokens = tokenize("Hello World");
    assert.deepEqual(tokens, ["hello", "world"]);
  });

  test("英文混合大小写转小写", () => {
    const tokens = tokenize("Promise API");
    assert.deepEqual(tokens, ["promise", "api"]);
  });

  test("纯中文产生单字和二字组", () => {
    const tokens = tokenize("你好");
    // 应该有两个单字 + 一个二字组
    assert.ok(tokens.includes("你"));
    assert.ok(tokens.includes("好"));
    assert.ok(tokens.includes("你好"));
    assert.equal(tokens.length, 3);
  });

  test("中文二字组数量等于字符长度减 1", () => {
    const tokens = tokenize("面试题");
    // 三个字 → 三个单字 + 两个二字组（面试、试题）
    assert.ok(tokens.includes("面"));
    assert.ok(tokens.includes("试"));
    assert.ok(tokens.includes("题"));
    assert.ok(tokens.includes("面试"));
    assert.ok(tokens.includes("试题"));
    assert.equal(tokens.length, 5);
  });

  test("中英混合产生两类词项", () => {
    const tokens = tokenize("Promise 面试");
    // promise + 面 + 试 + 面试
    assert.ok(tokens.includes("promise"));
    assert.ok(tokens.includes("面"));
    assert.ok(tokens.includes("试"));
    assert.ok(tokens.includes("面试"));
  });

  test("标点不产生空词项", () => {
    const tokens = tokenize("Hello, World!");
    // 逗号和叹号被忽略
    assert.deepEqual(tokens, ["hello", "world"]);
  });

  test("多余空白不产生空词项", () => {
    const tokens = tokenize("  Hello   World  ");
    assert.deepEqual(tokens, ["hello", "world"]);
  });

  test("数字与下划线保留在词项中", () => {
    const tokens = tokenize("http_proxy");
    // http_proxy 应该保持完整，不被切开
    assert.deepEqual(tokens, ["http_proxy"]);
  });

  test("标识符可包含数字", () => {
    const tokens = tokenize("http2 protocol");
    assert.ok(tokens.includes("http2"));
    assert.ok(tokens.includes("protocol"));
  });

  test("中文冒号作为分隔符", () => {
    const tokens = tokenize("Promise：面试题");
    // 中文冒号应该被跳过
    assert.ok(tokens.includes("promise"));
    assert.ok(tokens.includes("面"));
    assert.ok(tokens.includes("试"));
    assert.ok(tokens.includes("题"));
  });

  test("只有标点和空白的输入返回空数组", () => {
    const tokens = tokenize("   !!!   ");
    assert.deepEqual(tokens, []);
  });

  test("混合中英、标点、空白", () => {
    const tokens = tokenize("Express 服务器: 快速构建");
    assert.ok(tokens.includes("express"));
    assert.ok(tokens.includes("服"));
    assert.ok(tokens.includes("务"));
    assert.ok(tokens.includes("器"));
    assert.ok(tokens.includes("服务"));
    assert.ok(tokens.includes("务器"));
    assert.ok(tokens.includes("快"));
    assert.ok(tokens.includes("速"));
    assert.ok(tokens.includes("构"));
    assert.ok(tokens.includes("建"));
    assert.ok(tokens.includes("快速"));
    assert.ok(tokens.includes("速构"));
    assert.ok(tokens.includes("构建"));
  });

  test("相邻非 CJK 单字不产生二字组", () => {
    const tokens = tokenize("a b c");
    // abc 都是单个拉丁字符，不应该产生二字组
    assert.deepEqual(tokens, ["a", "b", "c"]);
  });

  test("CJK 和拉丁混合时 CJK 二字组仍产生", () => {
    const tokens = tokenize("ab好中ef");
    // ab 和 ef 是拉丁，好中 是中文
    // 应该有：ab, 好, 中, ef, 好中
    assert.ok(tokens.includes("ab"));
    assert.ok(tokens.includes("ef"));
    assert.ok(tokens.includes("好"));
    assert.ok(tokens.includes("中"));
    assert.ok(tokens.includes("好中"));
  });

  test("日文假名被识别为 CJK", () => {
    const tokens = tokenize("ひらがな");
    // 日文假名应该被识别为 CJK
    assert.ok(tokens.length > 0);
    assert.ok(tokens.some((t) => t === "ひ"));
  });

  test("连续数字作为单个词项", () => {
    const tokens = tokenize("123 456");
    assert.deepEqual(tokens, ["123", "456"]);
  });

  test("下划线与数字字母混合", () => {
    const tokens = tokenize("_test_123 var_name");
    assert.ok(tokens.includes("_test_123"));
    assert.ok(tokens.includes("var_name"));
  });

  test("空字符串返回空数组", () => {
    const tokens = tokenize("");
    assert.deepEqual(tokens, []);
  });

  test("禁用 CJK 单字", () => {
    const tokens = tokenize("面试题", { cjkUnigram: false, cjkBigram: true });
    // 应该只有二字组
    assert.ok(tokens.includes("面试"));
    assert.ok(tokens.includes("试题"));
    assert.ok(!tokens.includes("面"));
    assert.ok(!tokens.includes("试"));
    assert.ok(!tokens.includes("题"));
  });

  test("禁用 CJK 二字组", () => {
    const tokens = tokenize("面试题", { cjkUnigram: true, cjkBigram: false });
    // 应该只有单字
    assert.ok(tokens.includes("面"));
    assert.ok(tokens.includes("试"));
    assert.ok(tokens.includes("题"));
    assert.ok(!tokens.includes("面试"));
    assert.ok(!tokens.includes("试题"));
  });

  test("禁用所有 CJK", () => {
    const tokens = tokenize("Promise 面试题", {
      cjkUnigram: false,
      cjkBigram: false,
    });
    // 应该只有拉丁词项
    assert.ok(tokens.includes("promise"));
    assert.ok(!tokens.includes("面"));
    assert.ok(!tokens.includes("试"));
    assert.ok(!tokens.includes("题"));
    assert.ok(!tokens.includes("面试"));
  });
});
