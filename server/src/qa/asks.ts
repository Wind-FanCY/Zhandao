/**
 * **提问记录**：每次问答循环（`qa/loop.ts` 的 `runAsk`）跑完之后落一条记录，
 * 记的是「问了什么、搜了什么词、引用了哪些材料、库里有没有答案」——**不记答案正文**。
 *
 * 文件：`<dataDir>/asks.jsonl`，追加式、坏行跳过、ENOENT 返回空数组。形状照抄
 * `push/log.ts` / `drills/records.ts`：追加式 jsonl、类型守卫而非 `as` 断言。
 *
 * **必须住 `data/` 而不是 `.cache/`**：问过这件事发生过就是发生过，删了算不出来——
 * 与**推送日志** `pushes.jsonl`、**练题记录** `drill-records.jsonl` 同一条理由
 * （不可再生的追加式历史），不是 ADR-0003 说的「可从别处重建的派生物」。
 *
 * **刻意不存答案正文**：答案是模型对材料的复述，属于**标注** `_Avoid_` 点名的「笔记」，
 * 往 `data/` 里堆一份没有增量的文字会稀释库里唯一值钱的那层（标注）。
 * 这与**预练**「作答文本不留存，只留会/不会那一位」是同一条理由的另一处应用。
 *
 * **存 `question` 的理由**：项目当前评估集（`data/eval/retrieval.jsonl`）最大的偏差来源
 * 是「查询绝大多数是我猜本人会问什么」（31 条里只有 1 条来自真实使用）。`asks.jsonl`
 * 是评估集的**候选池**——注意它**不是**评估集本身，从这里挑进评估集仍需本人复核
 * （CLAUDE.md：「评估集的增删改需本人复核」）。
 *
 * **`found: false` 的行最值钱**：那是库里没有答案的问题，等于**收录信号**——
 * 告诉本人接下来该去收什么，而不是简单的失败记录。
 *
 * 与 `push/log.ts` 的 `readLastPushTimes` 不同，这里**不需要"取最新一条"这种去重**：
 * 每次 `runAsk` 都是一次独立的提问事件，不像"推送状态"或"练题会不会"那样有
 * 覆盖语义，所以 `readAsks` 直接按文件里的顺序（= 追加顺序 = 时间顺序）整体返回。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface AskRecord {
  question: string;
  at: string; // ISO 8601
  queries: string[]; // 循环实际搜过的词
  cites: string[]; // 材料 id
  found: boolean; // false = 库里没有 —— 这是收录信号
  rounds: number;
}

function asksPath(): string {
  return resolve(resolveDataDir(), "asks.jsonl");
}

/**
 * 追加一条**提问记录**。
 *
 * 使用追加写，避免读改写整个文件——与 `push/log.ts` 的 `appendPush` 同一手法。
 */
export async function appendAsk(r: AskRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const line = JSON.stringify(r);
  await writeFile(asksPath(), line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取全部**提问记录**，按文件里的顺序（= 追加顺序）返回。
 *
 * 文件不存在时返回空数组，不抛错；坏行跳过，好行保留。
 */
export async function readAsks(): Promise<AskRecord[]> {
  let content: string;
  try {
    content = await readFile(asksPath(), "utf-8");
  } catch (err) {
    // instanceof + in 收窄而非 `as NodeJS.ErrnoException` 断言——与
    // push/log.ts 的 readLastPushTimes 同一处理法
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records: AskRecord[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = extractAskRecord(parsed);
      if (!record) continue;
      records.push(record);
    } catch {
      // 忽略解析错误的行
    }
  }

  return records;
}

/**
 * 判断一个值是否为字符串数组。用于收窄 `queries` / `cites` 这两个数组字段，
 * 手写 `Array.isArray` + 逐项 `typeof`，而不是 `as string[]` 断言——
 * 断言拦不住"数组里混了一个数字"这种坏形状。
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 从任意解析出的 JSON 值里取出一条 AskRecord。
 * 用类型守卫而非 `as` 断言收窄——坏行/形状不对的行返回 null 而不是让编译器假装它对。
 */
function extractAskRecord(value: unknown): AskRecord | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("question" in value) ||
    !("at" in value) ||
    !("queries" in value) ||
    !("cites" in value) ||
    !("found" in value) ||
    !("rounds" in value)
  ) {
    return null;
  }

  const question = typeof value.question === "string" ? value.question : undefined;
  const at = typeof value.at === "string" ? value.at : undefined;
  const queries = isStringArray(value.queries) ? value.queries : undefined;
  const cites = isStringArray(value.cites) ? value.cites : undefined;
  const found = typeof value.found === "boolean" ? value.found : undefined;
  const rounds = typeof value.rounds === "number" ? value.rounds : undefined;

  if (
    question === undefined ||
    at === undefined ||
    queries === undefined ||
    cites === undefined ||
    found === undefined ||
    rounds === undefined
  ) {
    return null;
  }

  return { question, at, queries, cites, found, rounds };
}
