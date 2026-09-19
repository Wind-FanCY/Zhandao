import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { cacheDrills, readCachedDrills } from "./cache.js";
import type { Drill } from "./anchor.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

const sampleDrill: Drill = {
  id: "mat1#什么是闭包",
  materialId: "mat1",
  question: "什么是闭包？",
  anchor: "### 什么是闭包？",
  anchorLine: 0,
};

describe("drills/cache.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-drills-cache-test-"));
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
    const result = await readCachedDrills("nonexistent-material");
    assert.strictEqual(result, null);
  });

  test("写入后能读回", async () => {
    await cacheDrills("mat1", [sampleDrill]);
    const result = await readCachedDrills("mat1");
    assert.deepStrictEqual(result, [sampleDrill]);
  });

  test("不同材料 id 各自独立缓存", async () => {
    await cacheDrills("mat1", [sampleDrill]);
    await cacheDrills("mat2", []);

    assert.deepStrictEqual(await readCachedDrills("mat1"), [sampleDrill]);
    assert.deepStrictEqual(await readCachedDrills("mat2"), []);
  });

  test("坏 JSON 当未命中处理，不抛错", async () => {
    const cacheDir = resolve(testDataDir, ".cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(resolve(cacheDir, "drills-mat3.json"), "不是合法 JSON{{{", "utf-8");

    const result = await readCachedDrills("mat3");
    assert.strictEqual(result, null);
  });

  test("形状不对（不是 Drill[]）当未命中处理", async () => {
    const cacheDir = resolve(testDataDir, ".cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      resolve(cacheDir, "drills-mat4.json"),
      JSON.stringify([{ id: "只有 id 字段" }]),
      "utf-8",
    );

    const result = await readCachedDrills("mat4");
    assert.strictEqual(result, null);
  });
});
