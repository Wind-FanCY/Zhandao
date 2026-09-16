/**
 * 从数据目录加载材料文件并建 BM25 索引。
 *
 * 文件格式：YAML frontmatter + Markdown 正文。
 * 索引文本 = 标题 + 正文（标题是本人给的标识，必须参与检索）。
 *
 * 容错设计：
 * - 目录不存在或为空 → 空索引，不抛错
 * - 单个文件 frontmatter 坏掉 → 跳过并记 warn，其余仍可索引
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { resolveDataDir } from "../data-dir.js";
import { buildIndex, search, type Bm25Index, type Doc } from "./bm25.js";

export interface IndexedMaterial {
  id: string;
  title: string;
  source: string;
  path: string;
}

export interface MaterialsIndex {
  readonly _index: Bm25Index;
  readonly _materials: Map<string, IndexedMaterial>;
}

/**
 * 从单个 Markdown 文件解析材料。
 *
 * 格式：
 * ```
 * ---
 * id: <ulid>
 * title: <string>
 * source: <string>
 * captured: <ISO8601>
 * ---
 *
 * <Markdown 正文>
 * ```
 *
 * @returns 如果成功返回 [material, indexText]；frontmatter 坏掉返回 null
 */
function parseMaterialFile(
  filepath: string,
  content: string,
): [IndexedMaterial, string] | null {
  // 找 frontmatter 边界
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    console.warn(`[search] 文件 ${filepath} 无 frontmatter 开始符 ---`);
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
    console.warn(`[search] 文件 ${filepath} 无 frontmatter 结束符 ---`);
    return null;
  }

  // 提取 frontmatter
  const frontmatterStr = lines.slice(1, endIdx).join("\n");
  let frontmatter: unknown;
  try {
    frontmatter = yamlLoad(frontmatterStr);
  } catch (err) {
    console.warn(
      `[search] 文件 ${filepath} 的 YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (typeof frontmatter !== "object" || frontmatter === null) {
    console.warn(`[search] 文件 ${filepath} 的 frontmatter 不是对象`);
    return null;
  }

  const fm = frontmatter as Record<string, unknown>;
  const id = fm.id as string | undefined;
  const title = fm.title as string | undefined;
  const source = fm.source as string | undefined;

  if (!id || !title || !source) {
    console.warn(
      `[search] 文件 ${filepath} 的 frontmatter 缺少必需字段 (id=${id}, title=${title}, source=${source})`,
    );
    return null;
  }

  // 提取正文（frontmatter 后面，跳过第一个空行）
  const markdownLines = lines.slice(endIdx + 1);
  // 去掉开头的空行
  while (markdownLines.length > 0 && markdownLines[0].trim() === "") {
    markdownLines.shift();
  }
  const markdown = markdownLines.join("\n");

  // 索引文本 = 标题 + 正文
  const indexText = `${title}\n\n${markdown}`;

  return [
    {
      id,
      title,
      source,
      path: filepath,
    },
    indexText,
  ];
}

/**
 * 从数据目录加载全部材料并建索引。
 *
 * @returns MaterialsIndex，目录不存在或为空时返回空索引
 */
export async function buildMaterialsIndex(): Promise<MaterialsIndex> {
  const dataDir = resolveDataDir();
  const materialsDir = resolve(dataDir, "materials");

  // 读取目录（不存在时返回空索引）
  let filenames: string[];
  try {
    filenames = await readdir(materialsDir);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // 目录不存在 → 空索引
      return {
        _index: buildIndex([]),
        _materials: new Map(),
      };
    }
    throw err;
  }

  // 处理 .md 文件
  const docs: Doc[] = [];
  const materials = new Map<string, IndexedMaterial>();

  for (const filename of filenames) {
    if (extname(filename) !== ".md") continue;

    const filepath = resolve(materialsDir, filename);

    try {
      const content = await readFile(filepath, "utf-8");
      const result = parseMaterialFile(filepath, content);

      if (!result) continue; // frontmatter 坏掉，跳过

      const [material, indexText] = result;
      docs.push({
        id: material.id,
        text: indexText,
      });
      materials.set(material.id, material);
    } catch (err) {
      console.warn(
        `[search] 读取文件 ${filepath} 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
  }

  // 建索引
  const index = buildIndex(docs);

  return {
    _index: index,
    _materials: materials,
  };
}

/**
 * 在材料索引中检索。
 *
 * @param index MaterialsIndex
 * @param query 查询文本
 * @param limit 返回结果数量限制
 * @returns 按分数降序的材料列表（包含分数）
 */
export function searchMaterials(
  index: MaterialsIndex,
  query: string,
  limit: number = 0,
): (IndexedMaterial & { score: number })[] {
  const hits = search(index._index, query, limit);

  return hits
    .map((hit) => {
      const material = index._materials.get(hit.id);
      if (!material) return null;
      return { ...material, score: hit.score };
    })
    .filter((item) => item !== null) as (IndexedMaterial & { score: number })[];
}
