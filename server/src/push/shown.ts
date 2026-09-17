import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveDataDir } from "../data-dir.js";

/**
 * 「今天是否已经提示过」的状态，供 `npm run push -- --once-per-day` 用。
 *
 * 放在 `.cache/` 里是因为它**可丢**（ADR-0003 给可重建派生物留的地方）：
 * 丢了最坏的后果是当天多提示一次，不是数据损失。
 *
 * 为什么需要它：SessionStart hook 每开一个会话就触发一次，一天可能好几次。
 * 同一行反复出现是噪音，而噪音会让人开始忽略它——这与
 * 「每天提醒本人欠着几十篇会让人不想打开它」是同一类问题。
 *
 * 用本地时区的日历日（与 `pickForPush` 的同日去重口径一致：launchd 与
 * 会话都跑在本机本地时区）。
 */
function shownPath(): string {
  return resolve(resolveDataDir(), ".cache", "push-last-shown");
}

export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function alreadyShownToday(now: Date = new Date()): Promise<boolean> {
  try {
    const raw = await readFile(shownPath(), "utf8");
    return raw.trim() === localDateKey(now);
  } catch {
    // 读不到（首次、或 .cache 被清过）就当没提示过：宁可多提示一次
    return false;
  }
}

export async function markShownToday(now: Date = new Date()): Promise<void> {
  const p = shownPath();
  await mkdir(resolve(p, ".."), { recursive: true });
  await writeFile(p, `${localDateKey(now)}\n`, "utf8");
}
