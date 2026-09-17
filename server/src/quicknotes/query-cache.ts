import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

/**
 * 缓存模型提炼出的检索查询，键是**速记** id（已经是 ULID，文件名安全，
 * 不需要再像 `extract-cache.ts` 那样为 URL 哈希）。
 *
 * 永久有效、不需要失效逻辑：`quicknotes.jsonl` 是追加式的，速记原文不可变，
 * 所以「原文 → 提炼查询」是一个纯函数，同一个 id 的缓存永远正确。
 * `.cache/` 是 ADR-0003 给可重建派生物留的地方，删了就重新调一次模型。
 */

function queryCachePath(noteId: string): string {
  return resolve(resolveDataDir(), ".cache", `query-${noteId}.txt`);
}

/** 缓存一条速记提炼出的查询。 */
export async function cacheDistilledQuery(noteId: string, query: string): Promise<void> {
  const cacheDir = resolve(resolveDataDir(), ".cache");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(queryCachePath(noteId), query, "utf-8");
}

/** 读取缓存的查询，未命中返回 null（不抛错——未命中是正常状态，不是错误）。 */
export async function readCachedQuery(noteId: string): Promise<string | null> {
  try {
    return await readFile(queryCachePath(noteId), "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
