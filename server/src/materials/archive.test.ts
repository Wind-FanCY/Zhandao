import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendArchived, readArchivedIds, type ArchivedRecord } from "./archive.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("archive.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-archive-test-"));
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

  test("readArchivedIds 在文件不存在时返回空 Map", async () => {
    const ids = await readArchivedIds();
    assert.ok(ids instanceof Map);
    assert.equal(ids.size, 0);
  });

  test("appendArchived 追加一条记录", async () => {
    const record: ArchivedRecord = {
      materialId: "mat-1",
      at: "2026-09-16T10:00:00.000Z",
    };

    await appendArchived(record);

    const content = await readFile(resolve(testDataDir, "materials-read.jsonl"), "utf-8");
    assert.match(content, /mat-1/);
    assert.match(content, /2026-09-16T10:00:00\.000Z/);
  });

  test("readArchivedIds 返回每份材料最早的一次留档时间", async () => {
    await appendArchived({ materialId: "mat-1", at: "2026-09-16T10:00:00.000Z" });
    // 同一篇材料被留档第二次，时间更晚
    await appendArchived({ materialId: "mat-1", at: "2026-09-18T09:00:00.000Z" });
    await appendArchived({ materialId: "mat-2", at: "2026-09-17T00:00:00.000Z" });

    const ids = await readArchivedIds();

    assert.equal(ids.size, 2);
    assert.equal(ids.get("mat-1"), "2026-09-16T10:00:00.000Z");
    assert.equal(ids.get("mat-2"), "2026-09-17T00:00:00.000Z");
  });

  test("readArchivedIds 在乱序写入时仍取最早时间", async () => {
    // 先写晚的，再写早的——不能假设文件里的顺序就是时间顺序
    await appendArchived({ materialId: "mat-1", at: "2026-09-20T00:00:00.000Z" });
    await appendArchived({ materialId: "mat-1", at: "2026-09-15T00:00:00.000Z" });

    const ids = await readArchivedIds();
    assert.equal(ids.get("mat-1"), "2026-09-15T00:00:00.000Z");
  });

  test("readArchivedIds 忽略坏行", async () => {
    const archivedPath = resolve(testDataDir, "materials-read.jsonl");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(testDataDir, { recursive: true });

    const content =
      JSON.stringify({ materialId: "mat-1", at: "2026-09-16T10:00:00.000Z" }) +
      "\n" +
      "not json\n" +
      "\n" +
      JSON.stringify({ materialId: "mat-2" }) + // 缺 at 字段
      "\n" +
      JSON.stringify({ materialId: "mat-3", at: "2026-09-17T00:00:00.000Z" }) +
      "\n";

    await writeFile(archivedPath, content, "utf-8");

    const ids = await readArchivedIds();
    assert.equal(ids.size, 2);
    assert.ok(ids.has("mat-1"));
    assert.ok(ids.has("mat-3"));
    assert.ok(!ids.has("mat-2"));
  });
});
