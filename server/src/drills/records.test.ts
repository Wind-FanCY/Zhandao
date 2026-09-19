import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendDrillRecord, readDrillVerdicts } from "./records.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("drills/records.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-drill-records-test-"));
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

  test("文件不存在时返回空 Map", async () => {
    const verdicts = await readDrillVerdicts();
    assert.strictEqual(verdicts.size, 0);
  });

  test("写入后能读回", async () => {
    await appendDrillRecord({
      drillId: "mat1#q1",
      materialId: "mat1",
      known: true,
      at: "2026-09-18T00:00:00.000Z",
    });

    const verdicts = await readDrillVerdicts();
    assert.strictEqual(verdicts.get("mat1#q1")?.known, true);
  });

  test("取最新一条而非最早——与 readArchivedIds 相反", async () => {
    await appendDrillRecord({
      drillId: "mat1#q1",
      materialId: "mat1",
      known: false,
      at: "2026-09-17T00:00:00.000Z",
    });
    await appendDrillRecord({
      drillId: "mat1#q1",
      materialId: "mat1",
      known: true,
      at: "2026-09-18T00:00:00.000Z",
    });

    const verdicts = await readDrillVerdicts();
    // 「上次我会不会」是当前状态，必须拿到后写入的那条（known: true），
    // 如果这里错取成最早那条会得到 false——这正是与 archive.ts 相反的地方
    assert.strictEqual(verdicts.get("mat1#q1")?.known, true);
    assert.strictEqual(verdicts.get("mat1#q1")?.at, "2026-09-18T00:00:00.000Z");
  });

  test("不同 drillId 互不影响", async () => {
    await appendDrillRecord({
      drillId: "mat1#q1",
      materialId: "mat1",
      known: true,
      at: "2026-09-18T00:00:00.000Z",
    });
    await appendDrillRecord({
      drillId: "mat1#q2",
      materialId: "mat1",
      known: false,
      at: "2026-09-18T00:00:01.000Z",
    });

    const verdicts = await readDrillVerdicts();
    assert.strictEqual(verdicts.size, 2);
    assert.strictEqual(verdicts.get("mat1#q1")?.known, true);
    assert.strictEqual(verdicts.get("mat1#q2")?.known, false);
  });

  test("坏行跳过", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(testDataDir, { recursive: true });
    await writeFile(
      resolve(testDataDir, "drill-records.jsonl"),
      '不是合法 JSON\n{"drillId":"mat1#q1","materialId":"mat1","known":true,"at":"2026-09-18T00:00:00.000Z"}\n{"drillId":"缺字段"}\n',
      "utf-8",
    );

    const verdicts = await readDrillVerdicts();
    assert.strictEqual(verdicts.size, 1);
    assert.strictEqual(verdicts.get("mat1#q1")?.known, true);
  });
});
