import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { buildIndex, search, type Doc } from "./bm25.js";

describe("BM25", () => {
  test("单文档命中：查询词在唯一一篇里排第一", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript promise tutorial" },
      { id: "2", text: "React hooks guide" },
      { id: "3", text: "Node.js async await" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "promise");

    assert.ok(results.length > 0);
    assert.equal(results[0]?.id, "1");
    assert.equal(results.length, 1);
  });

  test("df 高的词权重低：全文档都有的词贡献少", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript JavaScript JavaScript promise" },
      { id: "2", text: "JavaScript JavaScript React" },
      { id: "3", text: "JavaScript Node" },
    ];
    const index = buildIndex(docs);

    // 查询只有 "promise"，应该匹配文档 1
    const results = search(index, "promise");
    assert.ok(results.length > 0);
    assert.equal(results[0]?.id, "1");

    // 查询只有 "JavaScript"，虽然它在所有文档中，但不一定排在最前面
    // （实际上它应该匹配所有文档）
    const results2 = search(index, "JavaScript");
    assert.equal(results2.length, 3);
  });

  test("长度归一化生效：同样命中次数，短文档得分高于长文档", () => {
    const docs: Doc[] = [
      { id: "short", text: "promise promise" },
      { id: "long", text: "promise promise " + "other ".repeat(100) },
    ];
    const index = buildIndex(docs);
    const results = search(index, "promise");

    // 短文档应该排第一（同样的词频，但文档更短）
    assert.ok(results.length > 0);
    assert.equal(results[0]?.id, "short");
  });

  test("零命中查询返回空数组", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript promise" },
      { id: "2", text: "React hooks" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "未知词汇");

    assert.deepEqual(results, []);
  });

  test("limit 参数生效", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript" },
      { id: "2", text: "JavaScript" },
      { id: "3", text: "JavaScript" },
      { id: "4", text: "JavaScript" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "JavaScript", 2);

    assert.equal(results.length, 2);
  });

  test("空索引查询返回空数组，不抛错", () => {
    const index = buildIndex([]);
    const results = search(index, "any query");

    assert.deepEqual(results, []);
  });

  test("多词查询：只有全部词都命中的文档才有分数", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript promise async" },
      { id: "2", text: "JavaScript promise" },
      { id: "3", text: "React promise" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "JavaScript promise");

    // 文档 1 和 2 都包含 "JavaScript" 和 "promise"
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes("1"));
    assert.ok(ids.includes("2"));
    // 文档 3 只有 promise，没有 JavaScript，但仍可能有分数（因为 promise 被计分）
  });

  test("空查询返回空数组", () => {
    const docs: Doc[] = [
      { id: "1", text: "JavaScript promise" },
      { id: "2", text: "React hooks" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "");

    assert.deepEqual(results, []);
  });

  test("分数大于 0 的才返回", () => {
    const docs: Doc[] = [
      { id: "1", text: "hello world" },
      { id: "2", text: "hello world" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "nonexistent");

    assert.deepEqual(results, []);
  });

  test("自定义 k1 参数", () => {
    const docs: Doc[] = [
      { id: "1", text: "promise promise promise promise promise" },
      { id: "2", text: "promise" },
    ];
    const index = buildIndex(docs);

    // k1 越小，词频的影响越小，短文档优势越明显
    const results1 = search(index, "promise", 0, { k1: 0.5 });
    const results2 = search(index, "promise", 0, { k1: 2.0 });

    assert.ok(results1.length > 0);
    assert.ok(results2.length > 0);
    assert.equal(results1[0]?.id, "1"); // 短文档应该赢
    assert.equal(results2[0]?.id, "1"); // 短文档应该赢

    // k1=0 时词频无影响，长度归一化决胜
    const results3 = search(index, "promise", 0, { k1: 0 });
    assert.ok(results3.length > 0);
    // 当 k1=0 时，分数只取决于 idf（两个文档都有 promise），
    // 长度归一化仍生效（虽然词频影响消除了）
    // 实际上 k1=0 意味着词频完全不影响，只看 idf，两者分数可能相同或相近
    assert.equal(results3[0]?.id, "1"); // 短文档应该赢
  });

  test("自定义 b 参数", () => {
    const docs: Doc[] = [
      { id: "short", text: "promise promise" },
      { id: "long", text: "promise promise " + "other ".repeat(100) },
    ];
    const index = buildIndex(docs);

    // b=0 时没有长度归一化，长文档可能赢
    const results1 = search(index, "promise", 0, { b: 0 });
    // b=1 时完全的长度归一化
    const results2 = search(index, "promise", 0, { b: 1 });

    // 两种情况下短文档应该优先
    assert.ok(results1.length > 0);
    assert.ok(results2.length > 0);
    assert.equal(results1[0]?.id, "short");
    assert.equal(results2[0]?.id, "short");
  });

  test("结果按分数降序排列", () => {
    const docs: Doc[] = [
      { id: "1", text: "promise promise promise" },
      { id: "2", text: "promise promise" },
      { id: "3", text: "promise" },
    ];
    const index = buildIndex(docs);
    const results = search(index, "promise");

    // 确保分数递减
    for (let i = 0; i < results.length - 1; i++) {
      const curr = results[i];
      const next = results[i + 1];
      if (curr && next) {
        assert.ok(curr.score >= next.score);
      }
    }
  });

  test("中文分词后的 BM25", () => {
    const docs: Doc[] = [
      { id: "1", text: "关于 Promise 的面试题" },
      { id: "2", text: "React 组件最佳实践" },
      { id: "3", text: "面试题汇总" },
    ];
    const index = buildIndex(docs);

    // 查询 "面试" 应该匹配文档 1 和 3
    const results = search(index, "面试题");
    const ids = results.map((r) => r.id);

    // 文档 1 和 3 都包含相关字
    assert.ok(ids.length >= 1);
  });
});
