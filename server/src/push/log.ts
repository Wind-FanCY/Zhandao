/**
 * **推送**日志：记录「哪份材料在什么时刻被真正推给了本人」，供 `pickForPush`
 * 在推送池的每个层级内部做轮转排序用（见 `pool.ts`）。
 *
 * 文件：`<dataDir>/pushes.jsonl`，追加式、坏行跳过、ENOENT 返回空。形状照抄
 * `materials/archive.ts`：追加式 jsonl、坏行跳过、类型守卫而非 `as` 断言。
 *
 * **必须住 `data/` 而不是 `.cache/`**：推送这个事件发生过就是发生过，删了重算不出来
 * ——这跟**练题记录**是同一条理由（不可再生的追加式历史），不是 ADR-0003 说的
 * 「可从别处重建的派生物」。
 * 现有的 `<dataDir>/.cache/push-last-shown`（按天去重状态）是另一回事，**保持不变**：
 * 那个丢了最坏多提示一次，是可丢弃的呈现层状态；这个丢了会让轮转失忆、退化回
 * 「卡住不动」，是不能接受的。
 *
 * **与 `readArchivedIds` 相反，注意别照抄错**：`readArchivedIds` 取每份材料**最早**
 * 一次留档时间——那是给「存量多老」排序用的。这里的 `readLastPushTimes` 取每份材料
 * **最新**一次推送时间——「上次什么时候推的」是当前状态，只有最新一次有意义，
 * 旧的推送记录不代表现在的排队位置。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface PushRecord {
  materialId: string;
  at: string; // ISO 8601
}

function pushesPath(): string {
  return resolve(resolveDataDir(), "pushes.jsonl");
}

/**
 * 追加一条**推送**记录。
 *
 * 使用追加写，避免读改写整个文件。调用方（`scripts/push.ts`）负责只在
 * 「本人这次真的看到了推送」时调用它——这个模块本身不做这个判断，纯粹的
 * 日志写入/读取，不掺决策。
 */
export async function appendPush(r: PushRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const line = JSON.stringify(r);
  await writeFile(pushesPath(), line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取全部**推送**记录，返回 材料id -> 最新一次推送时间 的 Map。
 *
 * 文件不存在时返回空 Map，不抛错；坏行跳过。
 */
export async function readLastPushTimes(): Promise<Map<string, string>> {
  let content: string;
  try {
    content = await readFile(pushesPath(), "utf-8");
  } catch (err) {
    // instanceof + in 收窄而非 `as NodeJS.ErrnoException` 断言——与
    // materials/archive.ts 的 readArchivedIds 同一处理法
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return new Map();
    }
    throw err;
  }

  const latest = new Map<string, string>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = extractPushRecord(parsed);
      if (!record) continue;

      const existing = latest.get(record.materialId);
      // ISO 8601 格式固定、可直接按字符串比较大小,取更晚的那次——
      // 「上次推送时间」只有最新一次有意义
      if (existing === undefined || record.at > existing) {
        latest.set(record.materialId, record.at);
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return latest;
}

/**
 * 从任意解析出的 JSON 值里取出一条 PushRecord。
 * 用类型守卫而非 `as` 断言收窄——坏行/形状不对的行返回 null 而不是让编译器假装它对。
 */
function extractPushRecord(value: unknown): PushRecord | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("materialId" in value) || !("at" in value)) return null;

  const materialId = typeof value.materialId === "string" ? value.materialId : undefined;
  const at = typeof value.at === "string" ? value.at : undefined;

  if (materialId === undefined || at === undefined) return null;

  return { materialId, at };
}
