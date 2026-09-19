/**
 * **练题记录**：本人对一道**练题**的一次自评结果（会 / 不会），只决定下一轮**预练**
 * 是否再出这道题（CONTEXT.md）。形状照抄 `materials/archive.ts`。
 *
 * 文件：`<dataDir>/drill-records.jsonl`，追加式、坏行跳过、ENOENT 返回空。
 * 这是不可再生的真实数据，与**练题清单**（`drills/cache.ts`，可丢弃派生物）分开存放。
 *
 * **与 `readArchivedIds` 关键的一处差异，别照抄错**：`readArchivedIds` 取每份材料
 * **最早**那次留档时间，因为那是**排序**用的存量年龄；而这里的「上次我会不会」是
 * **当前状态**，同一道练题可能被反复自评（这轮说不会、下轮补完标注后再练说会了），
 * 旧记录已经被推翻，所以 `readDrillVerdicts` 取**最新**那次。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface DrillRecord {
  drillId: string;
  materialId: string;
  known: boolean;
  at: string; // ISO 8601
}

/** 追加一条**练题记录**。使用追加写，避免读改写整个文件。 */
export async function appendDrillRecord(r: DrillRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const recordsPath = resolve(dataDir, "drill-records.jsonl");
  const line = JSON.stringify(r);

  await writeFile(recordsPath, line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取全部**练题记录**，返回 练题id -> 最新一条记录 的 Map。
 *
 * 取**最新**而非最早（与 `materials/archive.ts` 的 `readArchivedIds` 相反，见文件头注释）。
 * 文件不存在时返回空 Map，不抛错；坏行跳过。
 */
export async function readDrillVerdicts(): Promise<Map<string, DrillRecord>> {
  const dataDir = resolveDataDir();
  const recordsPath = resolve(dataDir, "drill-records.jsonl");

  let content: string;
  try {
    content = await readFile(recordsPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return new Map();
    }
    throw err;
  }

  const latest = new Map<string, DrillRecord>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = extractDrillRecord(parsed);
      if (!record) continue;

      const existing = latest.get(record.drillId);
      // `>=`：同一 drillId 的记录按文件里出现的先后即时间先后，tie 时后写入的那条更新，
      // 取它没错——与「取最新」的语义一致
      if (existing === undefined || record.at >= existing.at) {
        latest.set(record.drillId, record);
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return latest;
}

/**
 * 从任意解析出的 JSON 值里取出一条 DrillRecord。
 * 用类型守卫而非 `as` 断言收窄——坏行/形状不对的行返回 null 而不是让编译器假装它对。
 */
function extractDrillRecord(value: unknown): DrillRecord | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("drillId" in value) ||
    !("materialId" in value) ||
    !("known" in value) ||
    !("at" in value)
  ) {
    return null;
  }

  const drillId = typeof value.drillId === "string" ? value.drillId : undefined;
  const materialId = typeof value.materialId === "string" ? value.materialId : undefined;
  const known = typeof value.known === "boolean" ? value.known : undefined;
  const at = typeof value.at === "string" ? value.at : undefined;

  if (drillId === undefined || materialId === undefined || known === undefined || at === undefined) {
    return null;
  }

  return { drillId, materialId, known, at };
}
