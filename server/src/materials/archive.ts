/**
 * **留档**的决策日志：读完一份**材料**后判定无可**标注**、但仍值得留在库中的动作
 * （CONTEXT.md）。形状照抄 `inbox/processed.ts`。
 *
 * 文件：`<dataDir>/materials-read.jsonl`，追加式、坏行跳过、ENOENT 返回空。
 *
 * 同一篇材料可能被**留档**多次（留档 → 重进池 → 又留档——见 CLAUDE.md「推送链路的
 * 实现约束」：留档不是终点，推送池会在孤岛清空后把它重新排进去）。
 * `readArchivedIds` 返回每份材料**最早**那次留档的时间：排序要用最早的，
 * 否则反复留档的材料会一直顶着「最新时间」永远排在队尾，实际上它是库里最老的存量之一。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface ArchivedRecord {
  materialId: string;
  at: string; // ISO 8601
}

/**
 * 追加一条**留档**记录。
 *
 * 使用追加写，避免读改写整个文件。
 */
export async function appendArchived(r: ArchivedRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const archivedPath = resolve(dataDir, "materials-read.jsonl");
  const line = JSON.stringify(r);

  await writeFile(archivedPath, line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取全部**留档**记录，返回 材料id -> 最早留档时间 的 Map。
 *
 * 文件不存在时返回空 Map，不抛错；坏行跳过。
 */
export async function readArchivedIds(): Promise<Map<string, string>> {
  const dataDir = resolveDataDir();
  const archivedPath = resolve(dataDir, "materials-read.jsonl");

  let content: string;
  try {
    content = await readFile(archivedPath, "utf-8");
  } catch (err) {
    // instanceof + in 收窄而非 `as NodeJS.ErrnoException` 断言——与
    // quicknotes/processed.ts 的 readProcessedNoteIds 同一处理法
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return new Map();
    }
    throw err;
  }

  const earliest = new Map<string, string>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const record = extractArchivedRecord(parsed);
      if (!record) continue;

      const existing = earliest.get(record.materialId);
      // ISO 8601（`new Date().toISOString()`）格式固定、可直接按字符串比较大小，
      // 取更早的那次——同一篇材料反复留档时，队列位置该看最早那次
      if (existing === undefined || record.at < existing) {
        earliest.set(record.materialId, record.at);
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return earliest;
}

/**
 * 从任意解析出的 JSON 值里取出一条 ArchivedRecord。
 * 用类型守卫而非 `as` 断言收窄——坏行/形状不对的行返回 null 而不是让编译器假装它对。
 */
function extractArchivedRecord(value: unknown): ArchivedRecord | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("materialId" in value) || !("at" in value)) return null;

  const materialId = typeof value.materialId === "string" ? value.materialId : undefined;
  const at = typeof value.at === "string" ? value.at : undefined;

  if (materialId === undefined || at === undefined) return null;

  return { materialId, at };
}
