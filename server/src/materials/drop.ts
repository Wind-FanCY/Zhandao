/**
 * 划掉一份**材料**：删文件 + 记日志。形状照抄 `inbox/processed.ts` 的决策日志一半，
 * 但多一步真实删除——**材料**（不同于**收件箱**条目）已经落盘，「划掉」意味着连文件
 * 一起清掉，不只是记一个决策。
 *
 * 日志：`<dataDir>/materials-dropped.jsonl`，追加式、坏行跳过、ENOENT 返回空。
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";
import { buildMaterialsIndex, getMaterial } from "../search/materials-index.js";

export interface DroppedRecord {
  materialId: string;
  at: string; // ISO 8601
}

/** 材料 id 在索引里找不到对应文件——不能静默成功，那会让人以为划掉生效了 */
export class MaterialNotFound extends Error {}

/**
 * 划掉一份材料。
 *
 * **顺序必须是先记日志、再删文件**：反过来的话删成功而记日志失败，就丢了
 * 「本人判断过、这份材料该走」这个事实——而那个判断不可再生（与归属链路
 * 「先写文件再记日志」同一个原则的镜像：谁是不可再生的谁先落地）。
 */
export async function dropMaterial(materialId: string): Promise<void> {
  const index = await buildMaterialsIndex();
  const material = getMaterial(index, materialId);
  if (!material) {
    throw new MaterialNotFound(`材料 ${materialId} 不存在`);
  }

  await appendDropped({ materialId, at: new Date().toISOString() });
  await unlink(material.path);
}

async function appendDropped(r: DroppedRecord): Promise<void> {
  const dataDir = resolveDataDir();

  await mkdir(dataDir, { recursive: true });

  const droppedPath = resolve(dataDir, "materials-dropped.jsonl");
  const line = JSON.stringify(r);

  await writeFile(droppedPath, line + "\n", { flag: "a", encoding: "utf-8" });
}

/**
 * 读取全部已划掉的材料 id，返回一个 Set。
 *
 * 文件不存在时返回空 Set，不抛错；坏行跳过。
 */
export async function readDroppedIds(): Promise<Set<string>> {
  const dataDir = resolveDataDir();
  const droppedPath = resolve(dataDir, "materials-dropped.jsonl");

  let content: string;
  try {
    content = await readFile(droppedPath, "utf-8");
  } catch (err) {
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
      const materialId = extractMaterialId(parsed);
      if (materialId !== undefined) {
        ids.add(materialId);
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  return ids;
}

/**
 * 从任意解析出的 JSON 值里取出 materialId 字段。
 * 用类型守卫而非 `as` 断言收窄。
 */
function extractMaterialId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("materialId" in value)) return undefined;
  return typeof value.materialId === "string" ? value.materialId : undefined;
}
