import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ulid } from "ulid";

import { resolveDataDir } from "../data-dir.js";

/**
 * 一条**速记**：本人当场记下、尚未归属到任何**材料**的一句话。
 * 它还不是**标注**——与「收件箱条目还不是材料」平行。见 ADR-0009。
 */
export type QuickNote = {
  id: string;
  text: string;
  /** ISO 8601 */
  at: string;
};

export class EmptyQuickNote extends Error {}

function quickNotesPath(): string {
  return resolve(resolveDataDir(), "quicknotes.jsonl");
}

/**
 * 追加一条速记。
 *
 * 刻意不做的事，都是 ADR-0009 的要求：
 * - 不要求指定宿主**材料**——当场找宿主是给最该轻的动作加最重的负担。
 * - 不调用模型、不做检索——那一刻不能有任何延迟。agent 只在之后批量归属时介入。
 * - 不需要服务在运行——只是往数据仓库追加一行。
 */
export async function appendQuickNote(text: string): Promise<QuickNote> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new EmptyQuickNote("速记内容为空");
  }

  const note: QuickNote = { id: ulid(), text: trimmed, at: new Date().toISOString() };

  await mkdir(resolveDataDir(), { recursive: true });
  // JSONL 追加：不需要读改写整个文件，且 git diff 只显示新增行
  await appendFile(quickNotesPath(), `${JSON.stringify(note)}\n`, "utf8");

  return note;
}

/** 读出全部速记。文件不存在时返回空数组，不抛错。 */
export async function readQuickNotes(): Promise<QuickNote[]> {
  let raw: string;
  try {
    raw = await readFile(quickNotesPath(), "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }

  const notes: QuickNote[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    // 坏行跳过而不是让整个文件不可读——这个文件会被手工编辑
    try {
      notes.push(JSON.parse(t) as QuickNote);
    } catch {
      continue;
    }
  }
  return notes;
}
