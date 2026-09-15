import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendProcessed, readProcessedUrls, type ProcessedRecord } from "./processed.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("processed.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-processed-test-"));
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

  test("readProcessedUrls should return empty Set when file doesn't exist", async () => {
    const urls = await readProcessedUrls();
    assert.ok(urls instanceof Set);
    assert.equal(urls.size, 0);
  });

  test("appendProcessed should create file and add record", async () => {
    const record: ProcessedRecord = {
      url: "https://example.com/article1",
      decision: "kept",
      at: new Date().toISOString(),
      materialId: "01K5F3ABC123",
    };

    await appendProcessed(record);

    const processedPath = resolve(testDataDir, "processed.jsonl");
    const content = await readFile(processedPath, "utf-8");

    assert.match(content, /https:\/\/example\.com\/article1/);
    assert.match(content, /"decision":"kept"/);
    assert.match(content, /01K5F3ABC123/);
  });

  test("readProcessedUrls should return URLs after append", async () => {
    const record1: ProcessedRecord = {
      url: "https://example.com/article1",
      decision: "kept",
      at: new Date().toISOString(),
      materialId: "id1",
    };

    const record2: ProcessedRecord = {
      url: "https://example.com/article2",
      decision: "dropped",
      at: new Date().toISOString(),
    };

    await appendProcessed(record1);
    await appendProcessed(record2);

    const urls = await readProcessedUrls();

    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://example.com/article1"));
    assert.ok(urls.has("https://example.com/article2"));
  });

  test("appendProcessed should append multiple records", async () => {
    const records: ProcessedRecord[] = [
      {
        url: "https://example.com/1",
        decision: "kept",
        at: new Date().toISOString(),
        materialId: "id1",
      },
      {
        url: "https://example.com/2",
        decision: "dropped",
        at: new Date().toISOString(),
      },
      {
        url: "https://example.com/3",
        decision: "kept",
        at: new Date().toISOString(),
        materialId: "id3",
      },
    ];

    for (const record of records) {
      await appendProcessed(record);
    }

    const content = await readFile(
      resolve(testDataDir, "processed.jsonl"),
      "utf-8",
    );
    const lines = content.trim().split("\n");

    assert.equal(lines.length, 3);

    // 每一行都应该是有效的 JSON
    for (const line of lines) {
      assert.doesNotThrow(() => {
        JSON.parse(line);
      });
    }
  });

  test("readProcessedUrls should ignore invalid JSON lines", async () => {
    const processedPath = resolve(testDataDir, "processed.jsonl");

    // 手动写入混有无效 JSON 的文件
    const validRecord: ProcessedRecord = {
      url: "https://example.com/valid",
      decision: "kept",
      at: new Date().toISOString(),
      materialId: "id1",
    };

    const content =
      JSON.stringify(validRecord) +
      "\n" +
      "invalid json line\n" +
      JSON.stringify({
        url: "https://example.com/valid2",
        decision: "dropped",
        at: new Date().toISOString(),
      }) +
      "\n";

    const { writeFile } = await import("node:fs/promises");
    await writeFile(processedPath, content, "utf-8");

    const urls = await readProcessedUrls();

    // 应该有两个有效的 URL，忽略无效的行
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://example.com/valid"));
    assert.ok(urls.has("https://example.com/valid2"));
  });

  test("readProcessedUrls should handle empty lines", async () => {
    const processedPath = resolve(testDataDir, "processed.jsonl");

    const validRecord: ProcessedRecord = {
      url: "https://example.com/test",
      decision: "kept",
      at: new Date().toISOString(),
      materialId: "id1",
    };

    const content =
      JSON.stringify(validRecord) +
      "\n" +
      "\n" +
      "\n" +
      JSON.stringify({
        url: "https://example.com/test2",
        decision: "dropped",
        at: new Date().toISOString(),
      }) +
      "\n";

    const { writeFile } = await import("node:fs/promises");
    await writeFile(processedPath, content, "utf-8");

    const urls = await readProcessedUrls();

    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://example.com/test"));
    assert.ok(urls.has("https://example.com/test2"));
  });

  test("appendProcessed should preserve exact record data", async () => {
    const record: ProcessedRecord = {
      url: "https://example.com/article?param=value&other=123",
      decision: "kept",
      at: "2026-09-15T21:04:00+08:00",
      materialId: "01K5F3ABC123XYZ",
    };

    await appendProcessed(record);

    const content = await readFile(
      resolve(testDataDir, "processed.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(content.trim()) as ProcessedRecord;

    assert.equal(parsed.url, record.url);
    assert.equal(parsed.decision, record.decision);
    assert.equal(parsed.at, record.at);
    assert.equal(parsed.materialId, record.materialId);
  });

  test("appendProcessed should work without materialId for dropped", async () => {
    const record: ProcessedRecord = {
      url: "https://example.com/dropped",
      decision: "dropped",
      at: new Date().toISOString(),
    };

    await appendProcessed(record);

    const content = await readFile(
      resolve(testDataDir, "processed.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(content.trim()) as ProcessedRecord;

    assert.equal(parsed.decision, "dropped");
    assert.equal(parsed.materialId, undefined);
  });
});
