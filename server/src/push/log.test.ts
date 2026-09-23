import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendPush, readLastPushTimes, type PushRecord } from "./log.js";

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
});
