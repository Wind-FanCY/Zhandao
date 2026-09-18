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
import { pickForPush } from "../push/pool.js";
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

  const candidate = await pickForPush();

  if (!candidate) {
    // 「今天没有」是合法输出，但 hook 场景下也不该出声
    if (!oncePerDay) console.log("今天没有要推的。");
    // 仍然记一天：池子空的话，今天再问几次也是空
    if (oncePerDay) await markShownToday();
    return;
  }

  const { material, kind, since } = candidate;

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
    if (oncePerDay) await markShownToday();
    return;
  }

  console.log(`[推送] ${kind} · ${material.title}`);
  console.log(`  来源：${material.source}`);
  console.log(`  since：${since}`);

  if (dryRun) {
    console.log("\n[dry-run] 不发通知。");
    if (oncePerDay) await markShownToday();
    return;
  }

  await sendNotification("Zhandao", `${kind}：${material.title}`);
  console.log("\n已发送系统通知。");
  if (oncePerDay) await markShownToday();
}

main().catch((err) => {
  console.error("[推送] 错误：", err instanceof Error ? err.message : err);
  process.exit(1);
});
