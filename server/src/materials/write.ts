import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { ulid } from "ulid";
import { dump as yamlDump } from "js-yaml";
import { resolveDataDir } from "../data-dir.js";
import { sanitizeForFilename } from "../filename.js";

export interface NewMaterial {
  /** 本人在过闸时确认或修改过的标题——不是书签标题，也不一定是抽取标题 */
  title: string;
  /** 抽取得到的正文 Markdown，不可修改 */
  markdown: string;
  /** 最终 URL（已去 fragment） */
  source: string;
}

export interface WrittenMaterial {
  id: string;
  path: string;
}

/**
 * 将一份材料写入磁盘。
 *
 * 文件路径：`<dataDir>/materials/<ulid>-<安全标题>.md`
 *
 * 文件内容：YAML frontmatter + 正文 Markdown
 *
 * 使用原子写入：先写到临时文件，再 rename 覆盖。
 */
export async function writeMaterial(m: NewMaterial): Promise<WrittenMaterial> {
  const dataDir = resolveDataDir();
  const materialsDir = resolve(dataDir, "materials");

  // 确保 materials 目录存在
  await mkdir(materialsDir, { recursive: true });

  // 生成 ULID
  const id = ulid();

  // 清理标题
  const cleanedTitle = sanitizeForFilename(m.title, 60);

  // 生成文件名
  const filename = cleanedTitle ? `${id}-${cleanedTitle}.md` : `${id}.md`;
  const filepath = resolve(materialsDir, filename);

  // 构建 frontmatter
  const frontmatter: Record<string, unknown> = {
    id,
    title: m.title,
    source: m.source,
    captured: new Date().toISOString(),
  };

  // 用 js-yaml 序列化 frontmatter
  const frontmatterStr = yamlDump(frontmatter, {
    // -1 才是「不限宽、不换行」；0 是「尽可能换行」，会把标题按空格拆成多行，
    // 于是 `grep "Promise 面试题"` 找不到它——而 ADR-0003 把可 grep 列为
    // 「文件是真相源」的收益之一。往返解析仍正确，但人和 grep 都读不了。
    lineWidth: -1,
  });

  // 构建完整文件内容
  const content = `---\n${frontmatterStr}---\n\n${m.markdown}`;

  // 原子写入：先写到临时文件，再 rename
  const tempFilename = `${filename}.tmp`;
  const tempFilepath = resolve(materialsDir, tempFilename);

  try {
    // 写到临时文件
    await writeFile(tempFilepath, content, "utf-8");
    // 原子 rename
    await rename(tempFilepath, filepath);
  } catch (err) {
    // 如果 rename 失败，尝试清理临时文件
    try {
      await import("node:fs/promises").then((fs) =>
        fs.unlink(tempFilepath).catch(() => {}),
      );
    } catch {}
    throw err;
  }

  return {
    id,
    path: filepath,
  };
}
