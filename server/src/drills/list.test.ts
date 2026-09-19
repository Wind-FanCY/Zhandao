import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { listDrills } from "./list.js";
import { cacheDrills, readCachedDrills } from "./cache.js";
import { appendDrillRecord } from "./records.js";
import type { Drill } from "./anchor.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

const markdown = ["### 什么是闭包？", "", "闭包是……"].join("\n");

describe("listDrills", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-drills-list-test-"));
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

  test("缓存未命中：调用 extractFn，写缓存，返回 lastKnown=null", async () => {
    let calls = 0;
    const extractFn = async () => {
      calls += 1;
      return [{ line: 0, question: "什么是闭包？" }];
    };

    const drills = await listDrills("mat1", markdown, extractFn);

    assert.strictEqual(calls, 1);
    assert.strictEqual(drills.length, 1);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.lastKnown, null);

    const cached = await readCachedDrills("mat1");
    assert.strictEqual(cached?.length, 1);
  });

  test("缓存命中时不调用 extractFn", async () => {
    const preBuilt: Drill[] = [
      {
        id: "mat1#什么是闭包",
        materialId: "mat1",
        question: "什么是闭包？",
        anchor: "### 什么是闭包？",
        anchorLine: 0,
      },
    ];
    await cacheDrills("mat1", preBuilt);

    let calls = 0;
    const extractFn = async () => {
      calls += 1;
      return [];
    };

    const drills = await listDrills("mat1", markdown, extractFn);

    assert.strictEqual(calls, 0, "缓存命中不应调用 extractFn");
    assert.strictEqual(drills.length, 1);
  });

  test("合并练题记录：有记录的题目带上 lastKnown", async () => {
    const preBuilt: Drill[] = [
      {
        id: "mat1#什么是闭包",
        materialId: "mat1",
        question: "什么是闭包？",
        anchor: "### 什么是闭包？",
        anchorLine: 0,
      },
    ];
    await cacheDrills("mat1", preBuilt);
    await appendDrillRecord({
      drillId: "mat1#什么是闭包",
      materialId: "mat1",
      known: false,
      at: "2026-09-18T00:00:00.000Z",
    });

    const drills = await listDrills("mat1", markdown, async () => []);
    const [first] = drills;
    assert.ok(first);
    assert.strictEqual(first.lastKnown, false);
  });

  test("不传 extractFn 时用默认的 extractDrills（缺 API key 会抛错，验证走到了真实实现）", async () => {
    const originalApiKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await assert.rejects(() => listDrills("mat-no-key", markdown));
    } finally {
      if (originalApiKey !== undefined) process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
  });
});
