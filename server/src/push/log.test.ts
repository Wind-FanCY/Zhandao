import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendPush, readLastPushTimes, readTodaysPush, type PushRecord } from "./log.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("push/log.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-push-log-test-"));
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

  test("readLastPushTimes 在文件不存在时返回空 Map", async () => {
    const times = await readLastPushTimes();
    assert.ok(times instanceof Map);
    assert.equal(times.size, 0);
  });

  test("appendPush 追加一条记录，落在 data/ 而不是 .cache/", async () => {
    const record: PushRecord = {
      materialId: "mat-1",
      at: "2026-09-20T10:00:00.000Z",
    };

    await appendPush(record);

    const content = await readFile(resolve(testDataDir, "pushes.jsonl"), "utf-8");
    assert.match(content, /mat-1/);
    assert.match(content, /2026-09-20T10:00:00\.000Z/);
  });

  test("readLastPushTimes 取每份材料最新的一次推送时间", async () => {
    // 同一个 materialId 写两条，断言拿到后写的那条（与 archive.ts 的
    // 「取最早」相反：这里「上次什么时候推的」只有最新一次有意义）
    await appendPush({ materialId: "mat-1", at: "2026-09-20T10:00:00.000Z" });
    await appendPush({ materialId: "mat-1", at: "2026-09-22T09:00:00.000Z" });
    await appendPush({ materialId: "mat-2", at: "2026-09-21T00:00:00.000Z" });

    const times = await readLastPushTimes();

    assert.equal(times.size, 2);
    assert.equal(times.get("mat-1"), "2026-09-22T09:00:00.000Z");
    assert.equal(times.get("mat-2"), "2026-09-21T00:00:00.000Z");
  });

  test("readLastPushTimes 在乱序写入时仍取最新时间", async () => {
    // 先写晚的，再写早的——不能假设文件里的顺序就是时间顺序
    await appendPush({ materialId: "mat-1", at: "2026-09-22T00:00:00.000Z" });
    await appendPush({ materialId: "mat-1", at: "2026-09-15T00:00:00.000Z" });

    const times = await readLastPushTimes();
    assert.equal(times.get("mat-1"), "2026-09-22T00:00:00.000Z");
  });

  test("readLastPushTimes 忽略坏行", async () => {
    const pushesPath = resolve(testDataDir, "pushes.jsonl");
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(testDataDir, { recursive: true });

    const content =
      JSON.stringify({ materialId: "mat-1", at: "2026-09-20T10:00:00.000Z" }) +
      "\n" +
      "not json\n" +
      "\n" +
      JSON.stringify({ materialId: "mat-2" }) + // 缺 at 字段
      "\n" +
      JSON.stringify({ materialId: "mat-3", at: "2026-09-21T00:00:00.000Z" }) +
      "\n";

    await writeFile(pushesPath, content, "utf-8");

    const times = await readLastPushTimes();
    assert.equal(times.size, 2);
    assert.ok(times.has("mat-1"));
    assert.ok(times.has("mat-3"));
    assert.ok(!times.has("mat-2"));
  });

  test("readTodaysPush 在文件不存在时返回 null", async () => {
    const record = await readTodaysPush(new Date("2026-09-26T12:00:00.000Z"));
    assert.equal(record, null);
  });

  // 注：这里的 UTC 时间戳都刻意选在同一个 UTC 日历日内相互靠近（或分属明显不同
  // 的 UTC 日历日），这样无论本地时区是什么，「今天」/「昨天」的判定都不会因为
  // 时区换算而在午夜附近翻面——与 pool.test.ts 里同日去重那组测试同一手法。
  test("readTodaysPush 今天推过 → 返回今天那条记录（材料 id 断言，不只判非空）", async () => {
    await appendPush({ materialId: "mat-today", at: "2026-09-26T02:00:00.000Z", kind: "孤岛" });

    const record = await readTodaysPush(new Date("2026-09-26T10:00:00.000Z"));
    assert.ok(record);
    assert.equal(record?.materialId, "mat-today");
    assert.equal(record?.kind, "孤岛");
  });

  test("readTodaysPush 跨天：记录是昨天的，今天问返回 null", async () => {
    await appendPush({ materialId: "mat-yesterday", at: "2026-09-24T12:00:00.000Z" });

    const record = await readTodaysPush(new Date("2026-09-26T12:00:00.000Z"));
    assert.equal(record, null);
  });

  test("readTodaysPush 同一天多条记录时取最新的一条", async () => {
    await appendPush({ materialId: "mat-early", at: "2026-09-26T01:00:00.000Z" });
    await appendPush({ materialId: "mat-late", at: "2026-09-26T09:00:00.000Z" });

    const record = await readTodaysPush(new Date("2026-09-26T14:00:00.000Z"));
    assert.equal(record?.materialId, "mat-late");
  });

  test("readTodaysPush：历史行没有 kind 字段时不被当成坏行丢弃，仍能返回它", async () => {
    const pushesPath = resolve(testDataDir, "pushes.jsonl");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(testDataDir, { recursive: true });

    // 手写一行没有 kind 字段的记录，模拟这次改动之前写下的历史行
    const legacyLine = JSON.stringify({
      materialId: "mat-legacy",
      at: "2026-09-26T05:00:00.000Z",
    });
    await writeFile(pushesPath, legacyLine + "\n", "utf-8");

    const record = await readTodaysPush(new Date("2026-09-26T12:00:00.000Z"));
    assert.ok(record);
    assert.equal(record?.materialId, "mat-legacy");
    assert.equal(record?.kind, undefined);
  });
});
