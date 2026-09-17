/**
 * 读取 `annotations/` 目录下全部**标注**。
 *
 * 形状照抄 `search/materials-index.ts` 的解析（YAML frontmatter + Markdown 正文，
 * frontmatter 坏掉的文件跳过并 warn，其余仍可读）——两处需要读这个目录：
 * 推送池要算「哪些材料已消化」（`material` / `targets` 字段），
 * 阅读视图要列出某份材料下挂着哪些标注（`text` / `at`）。
 * 与其各写一份解析，不如抽这一份共用。
 *
 * 容错设计：
 * - 目录不存在或为空 → 空数组，不抛错
 * - 单个文件 frontmatter 坏掉 → 跳过并记 warn，其余仍可读
 *
 * 不用 `as` 断言收窄 frontmatter：narrow 手法与 `quicknotes/processed.ts` 的
 * `extractQuickNoteId` 一致——`"字段" in value` 之后 TS 会把 `value.字段` 的类型
 * 收窄成 `unknown`，再用 `typeof` 精确判断。
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { resolveDataDir } from "../data-dir.js";

export interface AnnotationRecord {
  id: string;
  /** 归属宿主——恰好一份材料，必然存在 */
  material: string;
  /** 关联——零到多份材料/标注，v1 恒为空数组（CLAUDE.md「功能优先级」） */
  targets: string[];
  at: string;
  /** 正文全文（frontmatter 之后的部分），标注文件的正文是真相源 */
  text: string;
  path: string;
}

function parseAnnotationFile(filepath: string, content: string): AnnotationRecord | null {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    console.warn(`[annotations] 文件 ${filepath} 无 frontmatter 开始符 ---`);
    return null;
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    console.warn(`[annotations] 文件 ${filepath} 无 frontmatter 结束符 ---`);
    return null;
  }

  const frontmatterStr = lines.slice(1, endIdx).join("\n");
  let frontmatter: unknown;
  try {
    frontmatter = yamlLoad(frontmatterStr);
  } catch (err) {
    console.warn(
      `[annotations] 文件 ${filepath} 的 YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (typeof frontmatter !== "object" || frontmatter === null) {
    console.warn(`[annotations] 文件 ${filepath} 的 frontmatter 不是对象`);
    return null;
  }

  const id =
    "id" in frontmatter && typeof frontmatter.id === "string" ? frontmatter.id : undefined;
  const material =
    "material" in frontmatter && typeof frontmatter.material === "string"
      ? frontmatter.material
      : undefined;
  const at =
    "at" in frontmatter && typeof frontmatter.at === "string" ? frontmatter.at : undefined;
  const targets =
    "targets" in frontmatter && Array.isArray(frontmatter.targets)
      ? frontmatter.targets.filter((t): t is string => typeof t === "string")
      : [];

  if (!id || !material || !at) {
    console.warn(
      `[annotations] 文件 ${filepath} 的 frontmatter 缺少必需字段 (id=${id}, material=${material}, at=${at})`,
    );
    return null;
  }

  // 提取正文（frontmatter 后面，跳过第一个空行），与 materials-index.ts 同样的规则
  const bodyLines = lines.slice(endIdx + 1);
  while (bodyLines.length > 0) {
    const first = bodyLines[0];
    if (first && first.trim() === "") {
      bodyLines.shift();
    } else {
      break;
    }
  }
  // trim：写入时 frontmatter 与正文之间留了空行（`---\n\n` + 正文），
  // 不去掉的话每条标注在界面上都顶着一个空行。
  const text = bodyLines.join("\n").trim();

  return { id, material, targets, at, text, path: filepath };
}

/**
 * 读取全部**标注**。
 *
 * @returns annotations/ 目录不存在或为空时返回空数组
 */
export async function readAnnotations(): Promise<AnnotationRecord[]> {
  const dataDir = resolveDataDir();
  const annotationsDir = resolve(dataDir, "annotations");

  let filenames: string[];
  try {
    filenames = await readdir(annotationsDir);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const records: AnnotationRecord[] = [];

  for (const filename of filenames) {
    if (extname(filename) !== ".md") continue;

    const filepath = resolve(annotationsDir, filename);

    try {
      const content = await readFile(filepath, "utf-8");
      const record = parseAnnotationFile(filepath, content);
      if (record) records.push(record);
    } catch (err) {
      console.warn(
        `[annotations] 读取文件 ${filepath} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
  }

  return records;
}
