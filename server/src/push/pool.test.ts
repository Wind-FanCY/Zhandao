import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeMaterial } from "../materials/write.js";
import { writeAnnotation } from "../annotations/write.js";
import { appendArchived } from "../materials/archive.js";
import { computePool, pickForPush } from "./pool.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("push/pool.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-pool-test-"));
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

  test("空库返回空池，pickForPush 返回 null", async () => {
    const pool = await computePool();
    assert.deepEqual(pool, []);

    const picked = await pickForPush();
    assert.equal(picked, null);
  });

  test("只有孤岛：按 captured 升序排列", async () => {
    // writeMaterial 内部用 Date.now() 打 captured 时间戳；两次顺序 await 调用之间
    // 时钟单调不减，先调用的那份材料 captured 更早——用这个天然时间差验证排序，
    // 不需要也不能从外部注入 captured（它由 writeMaterial 内部生成）。
    const first = await writeMaterial({ title: "先收录", markdown: "x", source: "https://a" });
    // 确保两次 captured 时间戳不落在同一毫秒，避免排序断言在极快的机器上偶发翻面
    await new Promise((r) => setTimeout(r, 5));
    const second = await writeMaterial({ title: "后收录", markdown: "x", source: "https://b" });

    const pool = await computePool();
    assert.equal(pool.length, 2);
    assert.ok(pool.every((c) => c.kind === "孤岛"));
    assert.equal(pool[0]?.material.id, first.id);
    assert.equal(pool[1]?.material.id, second.id);
  });

  test("已消化的材料（有标注挂在它上）不进池", async () => {
    const withAnnotation = await writeMaterial({ title: "已标注", markdown: "x", source: "https://a" });
    const withoutAnnotation = await writeMaterial({ title: "未标注", markdown: "x", source: "https://b" });

    await writeAnnotation({ materialId: withAnnotation.id, text: "这是一条标注" });

    const pool = await computePool();
    const ids = pool.map((c) => c.material.id);

    assert.ok(!ids.includes(withAnnotation.id));
    assert.ok(ids.includes(withoutAnnotation.id));
  });

  test("被某条标注的 targets 指向的材料也算已消化，不算孤岛", async () => {
    const host = await writeMaterial({ title: "标注宿主", markdown: "x", source: "https://a" });
    const target = await writeMaterial({ title: "被关联的材料", markdown: "x", source: "https://b" });

    // writeAnnotation 恒写 targets: []，这里手动模拟一条带 targets 的标注文件
    // 来测试「targets 指向的材料也算已消化」这条规则本身，与关联功能是否已实现无关。
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolveDataDir } = await import("../data-dir.js");
    const annotationsDir = resolve(resolveDataDir(), "annotations");
    await mkdir(annotationsDir, { recursive: true });
    const content = `---
id: ann-with-targets
material: ${host.id}
targets:
  - ${target.id}
at: 2026-09-16T10:00:00.000Z
---

这条标注同时指向另一份材料。`;
    await writeFile(resolve(annotationsDir, "ann-with-targets.md"), content, "utf-8");

    const pool = await computePool();
    const ids = pool.map((c) => c.material.id);

    assert.ok(!ids.includes(host.id));
    assert.ok(!ids.includes(target.id));
  });

  test("只有留档：按最早留档时间升序排列", async () => {
    const matA = await writeMaterial({ title: "A", markdown: "x", source: "https://a" });
    const matB = await writeMaterial({ title: "B", markdown: "x", source: "https://b" });

    await appendArchived({ materialId: matA.id, at: "2026-09-18T00:00:00.000Z" });
    await appendArchived({ materialId: matB.id, at: "2026-09-10T00:00:00.000Z" });

    const pool = await computePool();
    assert.equal(pool.length, 2);
    assert.ok(pool.every((c) => c.kind === "留档"));
    assert.equal(pool[0]?.material.id, matB.id);
    assert.equal(pool[1]?.material.id, matA.id);
    assert.equal(pool[0]?.since, "2026-09-10T00:00:00.000Z");
  });

  test("孤岛与留档都有：孤岛全部排在留档之前", async () => {
    const island = await writeMaterial({ title: "孤岛材料", markdown: "x", source: "https://a" });
    const archived = await writeMaterial({ title: "留档材料", markdown: "x", source: "https://b" });

    // 留档时间设得比孤岛的 captured 早很多，验证排序仍是「孤岛优先」而非纯按时间
    await appendArchived({ materialId: archived.id, at: "2000-01-01T00:00:00.000Z" });

    const pool = await computePool();
    assert.equal(pool.length, 2);
    assert.equal(pool[0]?.kind, "孤岛");
    assert.equal(pool[0]?.material.id, island.id);
    assert.equal(pool[1]?.kind, "留档");
    assert.equal(pool[1]?.material.id, archived.id);
  });

  test("留档后又被标注：从留档池里移出，不重新进池", async () => {
    const mat = await writeMaterial({ title: "先留档后标注", markdown: "x", source: "https://a" });
    await appendArchived({ materialId: mat.id, at: "2026-09-10T00:00:00.000Z" });
    await writeAnnotation({ materialId: mat.id, text: "后来还是写了标注" });

    const pool = await computePool();
    assert.equal(pool.length, 0);
  });

  test("pickForPush：留档时间是今天则返回 null（同日去重，不是间隔算法）", async () => {
    const mat = await writeMaterial({ title: "今天刚留档", markdown: "x", source: "https://a" });
    const now = new Date("2026-09-18T15:00:00.000Z");
    await appendArchived({ materialId: mat.id, at: "2026-09-18T03:00:00.000Z" });

    const picked = await pickForPush(now);
    assert.equal(picked, null);
  });

  test("pickForPush：留档时间不是今天则正常返回", async () => {
    const mat = await writeMaterial({ title: "昨天留档", markdown: "x", source: "https://a" });
    const now = new Date("2026-09-18T15:00:00.000Z");
    await appendArchived({ materialId: mat.id, at: "2026-09-17T03:00:00.000Z" });

    const picked = await pickForPush(now);
    assert.ok(picked);
    assert.equal(picked?.material.id, mat.id);
    assert.equal(picked?.kind, "留档");
  });

  test("pickForPush：孤岛不受同日限制，即使 captured 是今天也照常返回", async () => {
    const mat = await writeMaterial({ title: "今天收录", markdown: "x", source: "https://a" });
    const now = new Date();

    const picked = await pickForPush(now);
    assert.ok(picked);
    assert.equal(picked?.material.id, mat.id);
    assert.equal(picked?.kind, "孤岛");
  });
});
