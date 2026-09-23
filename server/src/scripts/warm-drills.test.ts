import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { writeMaterial } from "../materials/write.js";
import { cacheDrills } from "../drills/cache.js";
import { warmAllDrills } from "./warm-drills.js";

// 形状照抄 materials/write.test.ts：mkdtemp + ZHANDAO_DATA_DIR，绝不碰真实 Zhandao/data，
// extractFn 全部注入假函数，绝不真的调 DeepSeek。
let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("warmAllDrills", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-warm-test-"));
    process.env.ZHANDAO_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("默认（不 force）跳过已缓存材料，且不调用 extractFn", async () => {
    const written = await writeMaterial({
      title: "已缓存材料",
      markdown: "## 一个标题\n\n正文",
      source: "https://example.com/a",
    });

    await cacheDrills(written.id, [
      {
        id: `${written.id}#existing`,
        materialId: written.id,
        question: "已有的问题？",
        anchor: "## 一个标题",
        anchorLine: 0,
      },
    ]);

    let calls = 0;
    const results = await warmAllDrills({
      extractFn: async () => {
        calls++;
        return [];
      },
    });

    assert.equal(calls, 0, "命中缓存的材料不该调用 extractFn");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.skipped, true);
    assert.equal(results[0]?.count, 1);
    assert.equal(results[0]?.error, undefined);
  });

  test("force: true 时对已缓存的材料也重新提取", async () => {
    const written = await writeMaterial({
      title: "已缓存材料",
      markdown: "## 一个标题\n\n正文",
      source: "https://example.com/a",
    });

    await cacheDrills(written.id, [
      {
        id: `${written.id}#old`,
        materialId: written.id,
        question: "旧问题？",
        anchor: "## 一个标题",
        anchorLine: 0,
      },
    ]);

    let calls = 0;
    const results = await warmAllDrills({
      force: true,
      extractFn: async (candidates) => {
        calls++;
        return candidates.map((c) => ({ line: c.line, question: "新问题？" }));
      },
    });

    assert.equal(calls, 1, "force 时即使命中缓存也该重新调用 extractFn");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.skipped, false);
    assert.equal(results[0]?.count, 1);
  });

  test("一篇抛错不中断整批：另外两篇仍然成功，出错那篇带 error", async () => {
    await writeMaterial({
      title: "A 材料",
      markdown: "## 标题A\n\n正文",
      source: "https://example.com/a",
    });
    await writeMaterial({
      title: "B 材料",
      markdown: "## 标题B\n\n正文",
      source: "https://example.com/b",
    });
    await writeMaterial({
      title: "C 材料",
      markdown: "## 标题C\n\n正文",
      source: "https://example.com/c",
    });

    const results = await warmAllDrills({
      extractFn: async (candidates) => {
        const text = candidates[0]?.text ?? "";
        if (text.includes("标题B")) {
          throw new Error("模拟模型失败：finish_reason=length，输出 0 tokens");
        }
        return candidates.map((c) => ({ line: c.line, question: `关于${c.text}的问题？` }));
      },
    });

    assert.equal(results.length, 3);
    const byTitle = new Map(results.map((r) => [r.title, r]));

    const a = byTitle.get("A 材料");
    const b = byTitle.get("B 材料");
    const c = byTitle.get("C 材料");

    assert.equal(a?.error, undefined);
    assert.equal(a?.count, 1);
    assert.equal(c?.error, undefined);
    assert.equal(c?.count, 1);

    assert.equal(b?.count, null);
    assert.ok(b?.error?.includes("模拟模型失败"), "失败原因必须原样保留，不能被吞掉");
  });

  test("onResult 对每篇材料都会被调用一次", async () => {
    await writeMaterial({
      title: "只有一篇",
      markdown: "## 唯一标题\n\n正文",
      source: "https://example.com/only",
    });

    const seen: string[] = [];
    await warmAllDrills({
      extractFn: async (candidates) => candidates.map((c) => ({ line: c.line, question: "问题？" })),
      onResult: (r) => seen.push(r.title),
    });

    assert.deepEqual(seen, ["只有一篇"]);
  });
});
