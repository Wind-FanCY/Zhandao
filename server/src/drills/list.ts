/**
 * 编排一份**材料**的**练题**清单：缓存命中就用缓存，未命中才机械收集候选行、调模型提取、
 * 校验、写缓存；再合并上每道题「上次会不会」的**练题记录**。供 `GET /api/materials/:id/drills` 使用。
 *
 * 候选行收集（`collectCandidateLines`）与模型调用之间的分工见 `anchor.ts` 顶部注释：
 * 机械只管「正文里有哪些标题/加粗行」，「挑哪些、怎么问」仍由模型判断。
 */

import { buildDrills, collectCandidateLines, type Drill } from "./anchor.js";
import { extractDrills } from "../model/extract-drills.js";
import { readCachedDrills, cacheDrills } from "./cache.js";
import { readDrillVerdicts } from "./records.js";

export interface DrillWithVerdict extends Drill {
  /** 上次自评结果；从未自评过则为 null（不是 false——「没做过」和「做过且答不会」不是一回事） */
  lastKnown: boolean | null;
}

export async function listDrills(
  materialId: string,
  markdown: string,
  extractFn?: (
    candidates: { line: number; text: string }[],
  ) => Promise<{ line: number; question: string }[]>,
): Promise<DrillWithVerdict[]> {
  const extract = extractFn ?? extractDrills;

  let drills = await readCachedDrills(materialId);

  if (drills === null) {
    const candidates = collectCandidateLines(markdown);
    const raw = await extract(candidates);
    drills = buildDrills(materialId, markdown, raw);
    await cacheDrills(materialId, drills);
  }

  const verdicts = await readDrillVerdicts();

  return drills.map((d) => {
    const record = verdicts.get(d.id);
    return { ...d, lastKnown: record ? record.known : null };
  });
}
