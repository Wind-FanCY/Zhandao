import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendAsk, readAsks, type AskRecord } from "./asks.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("qa/asks.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-qa-asks-test-"));
    process.env.ZHANDAO_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("readAsks 在文件不存在时返回空数组，不抛错", async () => {
    const records = await readAsks();
    assert.deepEqual(records, []);
  });

  test("appendAsk 追加多条后 readAsks 顺序正确", async () => {
    const r1: AskRecord = {
      question: "undici 为什么不读 http_proxy",
      at: "2026-09-20T10:00:00.000Z",
      queries: ["undici 代理"],
      cites: ["mat-1"],
      found: true,
      rounds: 2,
    };
    const r2: AskRecord = {
      question: "防抖和节流的区别",
      at: "2026-09-21T09:00:00.000Z",
      queries: ["防抖", "节流"],
      cites: ["mat-2", "mat-3"],
      found: true,
      rounds: 3,
    };
    const r3: AskRecord = {
      question: "SSE 和 WebSocket 的区别",
      at: "2026-09-22T08:00:00.000Z",
      queries: ["SSE WebSocket 区别"],
      cites: [],
      found: false,
      rounds: 6,
    };

    await appendAsk(r1);
    await appendAsk(r2);
    await appendAsk(r3);

    const records = await readAsks();
    assert.equal(records.length, 3);
    assert.deepEqual(records[0], r1);
    assert.deepEqual(records[1], r2);
    assert.deepEqual(records[2], r3);
  });

  test("found: false 的行能正确读回（收录信号）", async () => {
    await appendAsk({
      question: "库里没有的东西",
      at: "2026-09-23T00:00:00.000Z",
      queries: ["一个查不到的词"],
      cites: [],
      found: false,
      rounds: 6,
    });

    const records = await readAsks();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.found, false);
    assert.deepEqual(records[0]?.cites, []);
  });

  test("空 queries / 空 cites 合法", async () => {
    await appendAsk({
      question: "一个还没搜过就答不出来的问题",
      at: "2026-09-24T00:00:00.000Z",
      queries: [],
      cites: [],
      found: false,
      rounds: 0,
    });

    const records = await readAsks();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.queries, []);
    assert.deepEqual(records[0]?.cites, []);
  });

  test("坏行跳过：非 JSON、缺字段、字段类型不对，好行仍保留", async () => {
    await mkdir(testDataDir, { recursive: true });

    const goodRecord: AskRecord = {
      question: "好行",
      at: "2026-09-25T00:00:00.000Z",
      queries: ["q"],
      cites: ["mat-1"],
      found: true,
      rounds: 1,
    };

    const lines = [
      "not json at all",
      JSON.stringify({ question: "缺字段" }), // 缺 at/queries/cites/found/rounds
      JSON.stringify({
        question: 123, // question 类型不对（应为 string）
        at: "2026-09-25T00:00:01.000Z",
        queries: ["q"],
        cites: [],
        found: true,
        rounds: 1,
      }),
      JSON.stringify({
        question: "queries 里混了非字符串",
        at: "2026-09-25T00:00:02.000Z",
        queries: ["q", 42], // 数组里混了数字
        cites: [],
        found: true,
        rounds: 1,
      }),
      JSON.stringify({
        question: "found 类型不对",
        at: "2026-09-25T00:00:03.000Z",
        queries: [],
        cites: [],
        found: "true", // 应为 boolean，不是字符串 "true"
        rounds: 1,
      }),
      JSON.stringify({
        question: "rounds 类型不对",
        at: "2026-09-25T00:00:04.000Z",
        queries: [],
        cites: [],
        found: false,
        rounds: "2", // 应为 number
      }),
      JSON.stringify({
        question: "cites 不是数组",
        at: "2026-09-25T00:00:05.000Z",
        queries: [],
        cites: "mat-1", // 应为数组
        found: false,
        rounds: 1,
      }),
      "", // 空行
      JSON.stringify(goodRecord),
    ];

    await writeFile(resolve(testDataDir, "asks.jsonl"), lines.join("\n") + "\n", "utf-8");

    const records = await readAsks();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], goodRecord);
  });
});
