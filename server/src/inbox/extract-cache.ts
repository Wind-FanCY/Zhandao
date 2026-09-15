import { createHash } from "node:crypto";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";

/**
 * 为 URL 生成稳定的缓存文件名。
 * 使用 SHA256 十六进制摘要确保文件系统安全且稳定。
 */
function getCacheFilename(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex");
  return `${hash}.md`;
}

/**
 * 缓存一篇抽取的正文。
 * 文件路径：`<dataDir>/.cache/<sha256>.md`
 *
 * @param url - 原始 URL
 * @param markdown - 正文 Markdown
 */
export async function cacheExtraction(url: string, markdown: string): Promise<void> {
  const dataDir = resolveDataDir();
  const cacheDir = resolve(dataDir, ".cache");

  // 确保缓存目录存在
  await mkdir(cacheDir, { recursive: true });

  const filename = getCacheFilename(url);
  const filepath = resolve(cacheDir, filename);

  // 直接写入（覆盖重复的 URL）
  await writeFile(filepath, markdown, "utf-8");
}

/**
 * 读取缓存的正文。
 *
 * @param url - 原始 URL
 * @returns 正文 Markdown，如果缓存不存在返回 null
 */
export async function readCachedExtraction(url: string): Promise<string | null> {
  const dataDir = resolveDataDir();
  const cacheDir = resolve(dataDir, ".cache");
  const filename = getCacheFilename(url);
  const filepath = resolve(cacheDir, filename);

  try {
    return await readFile(filepath, "utf-8");
  } catch (err) {
    // 文件不存在或其他读取错误，返回 null
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
