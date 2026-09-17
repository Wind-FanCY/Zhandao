/**
 * 推送触发脚本：`npm run push`（加 `--dry-run` 只打印，不发通知）。
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

  const dryRun = process.argv.slice(2).includes("--dry-run");

  const candidate = await pickForPush();

  if (!candidate) {
    console.log("今天没有要推的。");
    return;
  }

  const { material, kind, since } = candidate;
  console.log(`[推送] ${kind} · ${material.title}`);
  console.log(`  来源：${material.source}`);
  console.log(`  since：${since}`);

  if (dryRun) {
    console.log("\n[dry-run] 不发通知。");
    return;
  }

  await sendNotification("Zhandao", `${kind}：${material.title}`);
  console.log("\n已发送系统通知。");
}

main().catch((err) => {
  console.error("[推送] 错误：", err instanceof Error ? err.message : err);
  process.exit(1);
});
