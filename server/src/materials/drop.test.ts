import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeMaterial } from "./write.js";
import { dropMaterial, readDroppedIds, MaterialNotFound } from "./drop.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("drop.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-drop-test-"));
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

  test("readDroppedIds 在文件不存在时返回空 Set", async () => {
    const ids = await readDroppedIds();
    assert.ok(ids instanceof Set);
    assert.equal(ids.size, 0);
  });

  test("dropMaterial 删文件并记日志", async () => {
    const written = await writeMaterial({
      title: "待划掉的材料",
      markdown: "正文内容",
      source: "https://example.com/x",
    });

    await dropMaterial(written.id);

    // 文件应已被删除
    await assert.rejects(() => access(written.path));

    // 日志里应有一条记录
    const content = await readFile(resolve(testDataDir, "materials-dropped.jsonl"), "utf-8");
    assert.match(content, new RegExp(written.id));

    const ids = await readDroppedIds();
    assert.ok(ids.has(written.id));
  });

  test("dropMaterial 对不存在的 id 抛 MaterialNotFound，不留下日志", async () => {
    await assert.rejects(() => dropMaterial("no-such-id"), MaterialNotFound);

    const ids = await readDroppedIds();
    assert.equal(ids.size, 0);
  });

  test("readDroppedIds 忽略坏行", async () => {
    const droppedPath = resolve(testDataDir, "materials-dropped.jsonl");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(testDataDir, { recursive: true });

    const content =
      JSON.stringify({ materialId: "mat-1", at: "2026-09-16T10:00:00.000Z" }) +
      "\n" +
      "not json\n" +
      JSON.stringify({ at: "2026-09-17T00:00:00.000Z" }) + // 缺 materialId
      "\n";

    await writeFile(droppedPath, content, "utf-8");

    const ids = await readDroppedIds();
    assert.equal(ids.size, 1);
    assert.ok(ids.has("mat-1"));
  });
});
