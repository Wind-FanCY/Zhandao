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
  // 用 typeof 收窄而非 `as string`：YAML 里 `id: 123` 会被解析成数字，
  // `as string` 只是断言、拦不住它，后面的真值检查也放它过去。
  const id = typeof fm.id === "string" ? fm.id : undefined;
  const title = typeof fm.title === "string" ? fm.title : undefined;
  const source = typeof fm.source === "string" ? fm.source : undefined;
  // 中文检索关键词（可选）。它存在的理由：中文查询命中纯英文材料的 recall@3
  // 实测为 0%，靠这些关键词补上——见 CLAUDE.md 的基线一节。
  const keywordsZh = Array.isArray(fm.keywords_zh)
    ? fm.keywords_zh.filter((k): k is string => typeof k === "string")
    : [];

  if (!id || !title || !source) {
    console.warn(
      `[search] 文件 ${filepath} 的 frontmatter 缺少必需字段 (id=${id}, title=${title}, source=${source})`,
    );
    return null;
  }

  // 提取正文（frontmatter 后面，跳过第一个空行）
  const markdownLines = lines.slice(endIdx + 1);
  // 去掉开头的空行
  while (markdownLines.length > 0) {
    const first = markdownLines[0];
    if (first && first.trim() === "") {
      markdownLines.shift();
    } else {
      break;
    }
  }
  const markdown = markdownLines.join("\n");

  // 索引文本 = 标题 + 中文关键词 + 正文
  const indexText = [title, keywordsZh.join(" "), markdown].filter(Boolean).join("\n\n");

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
/**
 * 按 id 取一份已索引的**材料**。
 *
 * 存在的理由：`MaterialsIndex` 的成员带 `_` 前缀，意在表示「内部结构」，
 * 但 TS 的下划线没有可见性含义。与其让调用方伸手进 `_materials`，
 * 不如给一个明确的访问器——下划线就真的只是「别直接碰」的提示。
 */
export function getMaterial(index: MaterialsIndex, id: string): IndexedMaterial | undefined {
  return index._materials.get(id);
}

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
    // 类型守卫而非 `as` 断言：断言会关掉收窄，守卫让编译器自己推出非 null
    .filter((item): item is IndexedMaterial & { score: number } => item !== null);
}
