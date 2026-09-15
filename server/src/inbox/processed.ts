import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

export interface ProcessedRecord {
  url: string;
  decision: "kept" | "dropped";
  at: string; // ISO 8601
  materialId?: string; // decision === "kept" 时存在
}

/**
 * 追加一条已处理的记录。
 *
 * 文件：`<dataDir>/processed.jsonl`
 * 格式：每行一条 JSON 对象
 *
 * 使用追加写，避免读改写整个文件。
 */
export async function appendProcessed(r: ProcessedRecord): Promise<void> {
  const dataDir = resolveDataDir();

  // 确保 data 目录存在
  await mkdir(dataDir, { recursive: true });

  const processedPath = resolve(dataDir, "processed.jsonl");

  // 序列化为 JSON
  const line = JSON.stringify(r);

  // 追加写（自动创建文件如果不存在）
  await writeFile(processedPath, line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取所有已处理的 URL，返回一个 Set。
 *
 * 文件不存在时返回空 Set，不抛错。
 */
export async function readProcessedUrls(): Promise<Set<string>> {
  const dataDir = resolveDataDir();
  const processedPath = resolve(dataDir, "processed.jsonl");

  try {
    const content = await readFile(processedPath, "utf-8");
    const urls = new Set<string>();

    for (const line of content.split("\n")) {
      // 忽略空行
      if (!line.trim()) continue;

      try {
        const record = JSON.parse(line) as ProcessedRecord;
        urls.add(record.url);
      } catch {
        // 忽略解析错误的行
      }
    }

    return urls;
  } catch (err) {
    // 文件不存在等错误，返回空 Set
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw err;
  }
}
