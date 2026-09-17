import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { cacheDistilledQuery, readCachedQuery } from "./query-cache.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("query-cache.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-query-cache-test-"));
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

  test("未命中返回 null", async () => {
    const result = await readCachedQuery("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.strictEqual(result, null);
  });

  test("写入后能读回", async () => {
    const noteId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await cacheDistilledQuery(noteId, "undici http_proxy 代理");

    const result = await readCachedQuery(noteId);
    assert.strictEqual(result, "undici http_proxy 代理");
  });

  test("不同 note id 各自独立缓存", async () => {
    await cacheDistilledQuery("note-a", "查询 A");
    await cacheDistilledQuery("note-b", "查询 B");

    assert.strictEqual(await readCachedQuery("note-a"), "查询 A");
    assert.strictEqual(await readCachedQuery("note-b"), "查询 B");
  });

  test("同一 note id 再次写入会覆盖", async () => {
    const noteId = "note-c";
    await cacheDistilledQuery(noteId, "旧查询");
    await cacheDistilledQuery(noteId, "新查询");

    assert.strictEqual(await readCachedQuery(noteId), "新查询");
  });

  test("缓存目录会被自动创建", async () => {
    const cacheDir = resolve(testDataDir, ".cache");
    await cacheDistilledQuery("note-d", "查询 D");

    const files = await readdir(cacheDir);
    assert.strictEqual(files.length, 1);
  });
});
