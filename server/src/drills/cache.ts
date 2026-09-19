import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDataDir } from "../data-dir.js";
import type { Drill } from "./anchor.js";

/**
 * 缓存一份**材料**提取出的**练题**清单，键是材料 id。形状照抄
 * `quicknotes/query-cache.ts`。
 *
 * 永久有效、不需要失效逻辑：**材料**正文不可改（CONTEXT.md：改了等于伪造引文），
 * 所以「正文 → 练题清单」是正文的纯函数，同一个材料 id 的缓存永远正确。
 * `.cache/` 是 ADR-0003 给可丢弃派生物留的地方，删了就重新调一次模型。
 *
 * 与**练题记录**（`drills/records.ts`）的关键区别：这里存的是可重建派生物，
 * 那边存的是不可再生的真实数据——两者不能放在一起，见 CLAUDE.md「预练链路的实现约束」。
 */

function drillsCachePath(materialId: string): string {
  return resolve(resolveDataDir(), ".cache", `drills-${materialId}.json`);
}

/** 缓存一份材料提取出的练题清单。 */
export async function cacheDrills(materialId: string, drills: Drill[]): Promise<void> {
  const cacheDir = resolve(resolveDataDir(), ".cache");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(drillsCachePath(materialId), JSON.stringify(drills), "utf-8");
}

/**
 * 读取缓存的练题清单，未命中返回 null（不抛错——未命中是正常状态，不是错误）。
 *
 * 缓存文件损坏（不是合法 JSON，或形状不对）时也当作未命中处理，而不是抛错：
 * `.cache/` 里的东西随时可能被手动改坏或截断写入，删了重新调一次模型的成本
 * 远低于让整条请求 500。用类型守卫校验形状，不靠类型断言蒙混过去。
 */
export async function readCachedDrills(materialId: string): Promise<Drill[] | null> {
  let content: string;
  try {
    content = await readFile(drillsCachePath(materialId), "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null; // 坏缓存当未命中——删了重跑成本为零
  }

  return isDrillArray(parsed) ? parsed : null;
}

/** 用类型守卫而非 `as` 断言校验单条 Drill 的形状。 */
function isDrill(value: unknown): value is Drill {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("id" in value) ||
    !("materialId" in value) ||
    !("question" in value) ||
    !("anchor" in value) ||
    !("anchorLine" in value)
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.materialId === "string" &&
    typeof value.question === "string" &&
    typeof value.anchor === "string" &&
    typeof value.anchorLine === "number"
  );
}

function isDrillArray(value: unknown): value is Drill[] {
  return Array.isArray(value) && value.every(isDrill);
}
