import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  appendNoteProcessed,
  readProcessedNoteIds,
  type NoteProcessedRecord,
} from "./processed.js";

/** 类型守卫而非 `as` 断言：测试里读回 JSON 解析结果时收窄类型 */
function assertIsRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected an object");
}

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("quicknotes/processed.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-notes-processed-test-"));
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

  test("readProcessedNoteIds 在文件不存在时返回空 Set", async () => {
    const ids = await readProcessedNoteIds();
    assert.ok(ids instanceof Set);
    assert.equal(ids.size, 0);
  });

  test("appendNoteProcessed 创建文件并写入记录", async () => {
    const record: NoteProcessedRecord = {
      quickNoteId: "01NOTE1",
      decision: "attached",
      at: new Date().toISOString(),
      annotationId: "01ANNOT1",
    };

    await appendNoteProcessed(record);

    const content = await readFile(resolve(testDataDir, "quicknotes-processed.jsonl"), "utf-8");
    assert.match(content, /01NOTE1/);
    assert.match(content, /"decision":"attached"/);
    assert.match(content, /01ANNOT1/);
  });

  test("readProcessedNoteIds 追加后能读回 id 集合", async () => {
    await appendNoteProcessed({
      quickNoteId: "n1",
      decision: "attached",
      at: new Date().toISOString(),
      annotationId: "a1",
    });
    await appendNoteProcessed({
      quickNoteId: "n2",
      decision: "dropped",
      at: new Date().toISOString(),
    });

    const ids = await readProcessedNoteIds();
    assert.equal(ids.size, 2);
    assert.ok(ids.has("n1"));
    assert.ok(ids.has("n2"));
  });

  test("dropped 记录不带 annotationId", async () => {
    await appendNoteProcessed({
      quickNoteId: "n1",
      decision: "dropped",
      at: new Date().toISOString(),
    });

    const content = await readFile(resolve(testDataDir, "quicknotes-processed.jsonl"), "utf-8");
    const parsed: unknown = JSON.parse(content.trim());
    assertIsRecord(parsed);
    assert.equal(parsed.decision, "dropped");
    assert.equal(parsed.annotationId, undefined);
  });

  test("坏行被跳过，不让整个文件不可读", async () => {
    const path = resolve(testDataDir, "quicknotes-processed.jsonl");
    await appendNoteProcessed({
      quickNoteId: "good1",
      decision: "attached",
      at: new Date().toISOString(),
      annotationId: "a1",
    });
    await writeFile(path, (await readFile(path, "utf-8")) + "这不是 JSON\n\n", "utf-8");
    await appendNoteProcessed({
      quickNoteId: "good2",
      decision: "dropped",
      at: new Date().toISOString(),
    });

    const ids = await readProcessedNoteIds();
    assert.deepEqual([...ids].sort(), ["good1", "good2"]);
  });

  test("形状不对的行（缺 quickNoteId 或类型不对）被忽略", async () => {
    const path = resolve(testDataDir, "quicknotes-processed.jsonl");
    const lines = [
      JSON.stringify({ decision: "attached", at: "2026-01-01" }), // 缺 quickNoteId
      JSON.stringify({ quickNoteId: 123, decision: "attached", at: "2026-01-01" }), // 类型不对
      JSON.stringify({ quickNoteId: "ok", decision: "attached", at: "2026-01-01" }),
      "null",
      "42",
    ];
    await writeFile(path, lines.join("\n") + "\n", "utf-8");

    const ids = await readProcessedNoteIds();
    assert.deepEqual([...ids], ["ok"]);
  });
});
