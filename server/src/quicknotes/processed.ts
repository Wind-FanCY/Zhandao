import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

/**
 * 一条**速记**的决策日志。形状照抄 `inbox/processed.ts`——
 * **归属**在结构上与**收录**平行：候选集分别是 `quicknotes.jsonl` / 书签夹，
 * 两个终态分别是 `attached`/`dropped` 与 `kept`/`dropped`。见 CLAUDE.md。
 */
export type NoteDecision = "attached" | "dropped";

export interface NoteProcessedRecord {
  quickNoteId: string;
  decision: NoteDecision;
  at: string; // ISO 8601
  annotationId?: string; // decision === "attached" 时存在
}

/**
 * 追加一条速记的处理记录。
 *
 * 文件：`<dataDir>/quicknotes-processed.jsonl`
 * 格式：每行一条 JSON 对象，追加写、避免读改写整个文件。
 */
export async function appendNoteProcessed(r: NoteProcessedRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const processedPath = resolve(dataDir, "quicknotes-processed.jsonl");
  const line = JSON.stringify(r);

  await writeFile(processedPath, line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取所有已处理的速记 id，返回一个 Set。
 *
 * 文件不存在时返回空 Set，不抛错；坏行跳过，不让整个文件不可读。
 */
export async function readProcessedNoteIds(): Promise<Set<string>> {
  const dataDir = resolveDataDir();
  const processedPath = resolve(dataDir, "quicknotes-processed.jsonl");

  let content: string;
  try {
    content = await readFile(processedPath, "utf-8");
  } catch (err) {
    // instanceof + in 收窄而非 `as NodeJS.ErrnoException` 断言——与 quicknotes/append.ts
    // 的 readQuickNotes 同一处理法
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return new Set();
    }
    throw err;
  }

  const ids = new Set<string>();

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    try {
      const parsed: unknown = JSON.parse(line);
      const quickNoteId = extractQuickNoteId(parsed);
      if (quickNoteId !== undefined) {
        ids.add(quickNoteId);
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return ids;
}

/**
 * 从任意解析出的 JSON 值里取出 quickNoteId 字段。
 * 用类型守卫而非 `as` 断言收窄——坏行/形状不对的行返回 undefined 而不是让编译器假装它对。
 */
function extractQuickNoteId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("quickNoteId" in value)) return undefined;
  return typeof value.quickNoteId === "string" ? value.quickNoteId : undefined;
}
