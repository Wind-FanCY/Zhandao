/**
 * 推送触发脚本：`npm run push`
 *   `--dry-run`       只打印，不发通知
 *   `--once-per-day`  今天已经提示过就**一个字都不输出**、直接退出
 *   `--hook`          输出 Claude Code 的 hook JSON（systemMessage），而不是给人读的文本
 *
 * `--once-per-day` 是给 Claude Code 的 `SessionStart` hook 用的：它每开一个会话
 * 就触发一次，一天可能好几次，而同一行反复出现是噪音。
 * **默认行为刻意不去重**——手动敲 `npm run push` 就该永远给答案。
 *
 * ADR-0004：由 launchd 到点唤醒这个小脚本，它读数据、算出今天该推哪一篇、
 * 发一条系统通知、退出——**不起常驻进程、不拉起 Web 服务、不碰模型**。
 * 本人点击通知才手动拉起主服务去读那篇材料。
 *
 * 「今天没有」是合法输出（CLAUDE.md「推送链路的实现约束」）：池子空了，
 * 或池首是今天刚留档的（同日去重），都正常退出（exit 0），不发通知。
 *
 * 不报总数、不给「还剩 N 篇」——每天提醒本人欠着几十篇会让人不想打开它。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTodaysPush } from "../push/today.js";
import { appendPush } from "../push/log.js";
import { initializeRuntime } from "../runtime.js";
import { alreadyShownToday, markShownToday } from "../push/shown.js";

const execFileAsync = promisify(execFile);

/**
 * 转义 AppleScript 字符串字面量里的反斜杠和双引号。
 * 中文标题里常见引号（「」不需要转义，但英文/直角引号 " 会把 AppleScript 字符串提前截断），
 * 反斜杠本身也会被 AppleScript 解释为转义符——两者都必须先处理，且反斜杠要先转义。
 */
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function sendNotification(title: string, body: string): Promise<void> {
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
  await execFileAsync("osascript", ["-e", script]);
}

async function main(): Promise<void> {
  initializeRuntime();

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const oncePerDay = args.includes("--once-per-day");
  // hook 模式。**`systemMessage` 是呈现给本人的那一条**，界面上显示为
  // 「SessionStart:resume says: …」。踩过的坑：一度同时设了 `suppressOutput: true`，
  // 结果连 systemMessage 一起被压掉，看起来像「SessionStart 不渲染 systemMessage」
  // ——**不要设 suppressOutput**。（未单独隔离验证，但那行 says 的内容正是
  // systemMessage 的值，而它出现的那次恰好是去掉 suppressOutput 的那次。）
  //
  // 纯 stdout 不行：hook 成功时界面几乎不显示（Claude Code 的设计是静默成功不打扰）。
  // additionalContext 进的是**模型**的上下文，只用来让模型知道今天推了什么，
  // **不要在里面指示模型复述**——systemMessage 已经显示过了，再说一遍是重复噪音。
  const hookMode = args.includes("--hook");

  // hook 场景下必须完全静默：SessionStart 的输出会进对话上下文，
  // 打一行「今天已提示过」本身就是它要消掉的那种噪音。
  if (oncePerDay && (await alreadyShownToday())) return;

  // 用 resolveTodaysPush 而不是 pickForPush：这样手动 `npm run push` 与今天
  // hook 说的是同一篇——「今天该读哪篇」是一个事实，不是每次调用各算各的。
  // 与 pickForPush 共用同一个 now，让「挑出这一条」与「记这一条是什么时候推的」
  // 指向同一时刻，不留时间差。
  const now = new Date();
  const candidate = await resolveTodaysPush(now);

  if (!candidate) {
    // 「今天没有」是合法输出，但 hook 场景下也不该出声
    if (!oncePerDay) console.log("今天没有要推的。");
    // 仍然记一天：池子空的话，今天再问几次也是空
    if (oncePerDay) await markShownToday();
    return;
  }

  const { material, kind, since } = candidate;

  // 只在「本人这次真的看到了推送」时才写推送日志，供下次 pickForPush 轮转用。
  // 判断标准是 --once-per-day 的去重闸这次放行了（能走到这里就说明放行了）——
  // 不是「候选存在」，也不看 hookMode / dryRun：
  //   - 不带 --once-per-day 的手动 `npm run push` 是**查询**，连敲五次不该把
  //     五篇材料轮转掉，所以不写；
  //   - 去重闸拦下的那次（当天第二次开会话）在上面 `alreadyShownToday` 就已经
  //     return 了，根本走不到这里，不需要额外判断；
  //   - --dry-run 不影响：它只管发不发系统通知，hook 场景本来就带着 --dry-run，
  //     而正文已经进对话、本人确实看到了那行字。
  //
  // **这里不会出现「重放旧记录又写一条新记录」的情况**：走到这一行之前，
  // 上面的 `resolveTodaysPush(now)` 必然是在“今天还没有记录”这个前提下算出
  // `candidate` 的——因为 `--once-per-day` 时若今天已经推过，
  // `alreadyShownToday()` 已经在函数开头 return 了；不带 `--once-per-day`
  // 的手动查询根本不会走到这个 `if (oncePerDay)` 分支。所以 `resolveTodaysPush`
  // 此刻必然走的是「今天没有定论 → pickForPush 计算」那条分支，
  // 这次 `appendPush` 写下的正是那条计算结果，不是对旧记录的重复写入。
  async function recordPushIfShown(): Promise<void> {
    if (oncePerDay) {
      await appendPush({ materialId: material.id, at: now.toISOString(), kind });
    }
  }

  if (hookMode) {
    console.log(
      JSON.stringify({
        systemMessage: `今天该读：${kind} · ${material.title}`,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          // 纯信息，不含指示：本人已经通过 systemMessage 看到了，模型不必复述。
          additionalContext:
            `今天的推送（本人已通过界面看到，不必复述）：${kind} · ${material.title}` +
            `（${material.source}，收录于 ${since.slice(0, 10)}）。` +
            `读完走三个终态之一：写标注 / 留档 / 划掉，界面在「阅读」标签。`,
        },
      }),
    );
    await recordPushIfShown();
    if (oncePerDay) await markShownToday();
    return;
  }

  console.log(`[推送] ${kind} · ${material.title}`);
  console.log(`  来源：${material.source}`);
  console.log(`  since：${since}`);

  if (dryRun) {
    console.log("\n[dry-run] 不发通知。");
    await recordPushIfShown();
    if (oncePerDay) await markShownToday();
    return;
  }

  await sendNotification("Zhandao", `${kind}：${material.title}`);
  console.log("\n已发送系统通知。");
  await recordPushIfShown();
  if (oncePerDay) await markShownToday();
}

main().catch((err) => {
  console.error("[推送] 错误：", err instanceof Error ? err.message : err);
  process.exit(1);
});
