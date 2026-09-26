import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeMaterial } from "../materials/write.js";
import { writeAnnotation } from "../annotations/write.js";
import { appendArchived } from "../materials/archive.js";
import { dropMaterial } from "../materials/drop.js";
import { appendPush } from "./log.js";
import { pickForPush } from "./pool.js";
import { resolveTodaysPush } from "./today.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("push/today.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-today-test-"));
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

  // 回归守卫：这就是 2026-09-26 那个 bug 本身——hook 推过之后，
  // 网页再问同一件事必须得到同一个答案，而不是被轮转排序算成「下一篇」。
  test("今天推过之后再问，答案不变：不是轮转后的下一篇", async () => {
    const a = await writeMaterial({ title: "A", markdown: "x", source: "https://a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await writeMaterial({ title: "B", markdown: "x", source: "https://b" });

    const now = new Date("2026-09-26T02:00:00.000Z");

    // 模拟 hook 那次：先算出今天该推的（此时还没有今天的记录，pickForPush 给出 A），
    // 再写日志——这正是 scripts/push.ts 里 --once-per-day 放行时做的事。
    const firstPick = await pickForPush(now);
    assert.equal(firstPick?.material.id, a.id);
    await appendPush({ materialId: a.id, at: now.toISOString(), kind: firstPick?.kind });

    // 网页在同一天稍后再问：如果直接调 pickForPush，会看到 A 刚推过、排到队尾，
    // 错误地给出 B——这正是要修的 bug。resolveTodaysPush 必须坚持给 A。
    const laterToday = new Date("2026-09-26T10:00:00.000Z");
    const resolved = await resolveTodaysPush(laterToday);
    assert.equal(resolved?.material.id, a.id);
  });

  test("今天没推过 → resolveTodaysPush 与 pickForPush 给出同一篇", async () => {
    await writeMaterial({ title: "唯一一篇", markdown: "x", source: "https://a" });

    const now = new Date("2026-09-26T02:00:00.000Z");
    const viaPick = await pickForPush(now);
    const viaResolve = await resolveTodaysPush(now);

    assert.ok(viaPick);
    assert.ok(viaResolve);
    assert.equal(viaResolve?.material.id, viaPick?.material.id);
    assert.equal(viaResolve?.kind, viaPick?.kind);
  });

  test("日期跨天：记录是昨天的，今天问时重新计算，不返回昨天那篇", async () => {
    const yesterday = await writeMaterial({ title: "昨天推的", markdown: "x", source: "https://a" });
    await new Promise((r) => setTimeout(r, 5));
    const today = await writeMaterial({ title: "今天该推的", markdown: "x", source: "https://b" });

    // 昨天的推送记录（48 小时前，跨 UTC 日历日，不受本地时区换算影响）
    await appendPush({
      materialId: yesterday.id,
      at: "2026-09-24T12:00:00.000Z",
      kind: "孤岛",
    });

    const now = new Date("2026-09-26T12:00:00.000Z");
    const resolved = await resolveTodaysPush(now);

    // 今天没有记录，昨天的记录不该被当成「今天的定论」；两篇都是孤岛、
    // 按 captured 升序排列，"昨天推的" 先收录，本该排池首——
    // 但它已经在 pushes.jsonl 里、只是不是今天的记录，resolveTodaysPush
    // 应该退回 pickForPush 正常计算，而不是被昨天那条记录锁死。
    assert.ok(resolved);
    const picked = await pickForPush(now);
    assert.equal(resolved?.material.id, picked?.material.id);
    void today;
  });

  test("历史行没有 kind 字段：今天推过的记录是历史行，仍能解出这一篇（kind 从池子里补）", async () => {
    const mat = await writeMaterial({ title: "历史记录指向的材料", markdown: "x", source: "https://a" });

    const now = new Date("2026-09-26T02:00:00.000Z");
    // 不带 kind 字段，模拟这次改动之前写下的历史行
    await appendPush({ materialId: mat.id, at: now.toISOString() });

    const resolved = await resolveTodaysPush(new Date("2026-09-26T10:00:00.000Z"));
    assert.ok(resolved);
    assert.equal(resolved?.material.id, mat.id);
    assert.equal(resolved?.kind, "孤岛");
  });

  test("今天推过的材料已被划掉（索引里查不到）→ 退回 pickForPush，不返回 null、不抛错", async () => {
    const dropped = await writeMaterial({ title: "会被划掉的", markdown: "x", source: "https://a" });
    await new Promise((r) => setTimeout(r, 5));
    const remaining = await writeMaterial({ title: "还在库里的", markdown: "x", source: "https://b" });

    const now = new Date("2026-09-26T02:00:00.000Z");
    await appendPush({ materialId: dropped.id, at: now.toISOString(), kind: "孤岛" });

    // 推送之后，本人当场把那篇材料划掉了——文件被删，索引里再也查不到它
    await dropMaterial(dropped.id);

    const resolved = await resolveTodaysPush(new Date("2026-09-26T10:00:00.000Z"));
    assert.ok(resolved);
    assert.equal(resolved?.material.id, remaining.id);
  });

  test("今天推过的材料后来被写了标注（离开池子）→ 历史行没有 kind 时退回 pickForPush", async () => {
    const annotated = await writeMaterial({ title: "推送之后被标注的", markdown: "x", source: "https://a" });
    await new Promise((r) => setTimeout(r, 5));
    const remaining = await writeMaterial({ title: "还没标注的", markdown: "x", source: "https://b" });

    const now = new Date("2026-09-26T02:00:00.000Z");
    // 历史行，没有 kind——池子里也查不到它现在的 kind（因为它已经离开了池子），
    // 这是 resolveTodaysPush 三条退路里的第三条。
    await appendPush({ materialId: annotated.id, at: now.toISOString() });
    await writeAnnotation({ materialId: annotated.id, text: "推送之后想明白了，写了条标注" });

    const resolved = await resolveTodaysPush(new Date("2026-09-26T10:00:00.000Z"));
    assert.ok(resolved);
    assert.equal(resolved?.material.id, remaining.id);
  });

  test("今天推过的是留档材料，kind 与 since 与池子当前状态一致", async () => {
    const mat = await writeMaterial({ title: "留档材料", markdown: "x", source: "https://a" });
    await appendArchived({ materialId: mat.id, at: "2026-09-20T00:00:00.000Z" });

    const now = new Date("2026-09-26T02:00:00.000Z");
    await appendPush({ materialId: mat.id, at: now.toISOString(), kind: "留档" });

    const resolved = await resolveTodaysPush(new Date("2026-09-26T10:00:00.000Z"));
    assert.ok(resolved);
    assert.equal(resolved?.material.id, mat.id);
    assert.equal(resolved?.kind, "留档");
    assert.equal(resolved?.since, "2026-09-20T00:00:00.000Z");
  });
});
