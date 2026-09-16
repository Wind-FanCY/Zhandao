import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveDataDir } from "../data-dir.js";
import { buildMaterialsIndex, getMaterial, searchMaterials } from "./materials-index.js";

/**
 * 一条评估样本。`expect` 是**材料**的 id。
 *
 * 评估集编码的是「什么算对」，属于本人的判断，因此存在数据仓库里
 * （`data/eval/retrieval.jsonl`），不是代码的测试固件。
 */
export type EvalCase = { query: string; expect: string; expect_title?: string };

export type EvalResult = {
  total: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  ranks: number[];
  /** 未命中的样本，便于逐条排查 */
  misses: { query: string; expectTitle: string; rank: number; topTitle: string }[];
};

export async function readEvalSet(): Promise<EvalCase[]> {
  const path = resolve(resolveDataDir(), "eval/retrieval.jsonl");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const cases: EvalCase[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      cases.push(JSON.parse(t) as EvalCase);
    } catch {
      continue; // 坏行跳过，不让整个评估集不可读
    }
  }
  return cases;
}

/** 目标材料的中文字符占比。用于按语言分组看指标——见下面 why。 */
async function cjkRatio(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  const cjk = (raw.match(/[一-鿿]/g) ?? []).length;
  const latin = (raw.match(/[a-zA-Z]/g) ?? []).length;
  return cjk + latin === 0 ? 0 : cjk / (cjk + latin);
}

export async function evaluate(cases: EvalCase[]): Promise<EvalResult> {
  const index = await buildMaterialsIndex();
  const ranks: number[] = [];
  const misses: EvalResult["misses"] = [];

  for (const c of cases) {
    const hits = searchMaterials(index, c.query);
    const pos = hits.findIndex((h) => h.id === c.expect);
    // 未出现在结果里按「比最差还差一位」计，避免把零命中当成好成绩
    const rank = pos === -1 ? hits.length + 1 : pos + 1;
    ranks.push(rank);
    if (rank !== 1) {
      misses.push({
        query: c.query,
        expectTitle: c.expect_title ?? c.expect,
        rank,
        topTitle: hits[0]?.title ?? "(无结果)",
      });
    }
  }

  const n = ranks.length || 1;
  return {
    total: ranks.length,
    recallAt1: ranks.filter((r) => r === 1).length / n,
    recallAt3: ranks.filter((r) => r <= 3).length / n,
    mrr: ranks.reduce((a, r) => a + 1 / r, 0) / n,
    ranks,
    misses,
  };
}

/**
 * 按目标材料的语言分组统计。
 *
 * **为什么必须分组**：实测整体 recall@1=60% 是把两个区间平均出来的——
 * 中文材料 100%、纯英文材料 0%。聚合指标掩盖了真正的失效模式（跨语言 gap）。
 * 见 CLAUDE.md 的 RAG 四阶段一节。
 */
export async function evaluateByLanguage(
  cases: EvalCase[],
): Promise<{ group: string; result: EvalResult }[]> {
  const index = await buildMaterialsIndex();
  const buckets = new Map<string, EvalCase[]>();

  for (const c of cases) {
    const target = getMaterial(index, c.expect);
    const group = target
      ? (await cjkRatio(target.path)) < 0.05
        ? "纯英文材料"
        : "含中文材料"
      : "未知";
    const arr = buckets.get(group) ?? [];
    arr.push(c);
    buckets.set(group, arr);
  }

  const out: { group: string; result: EvalResult }[] = [];
  for (const [group, arr] of [...buckets].sort()) {
    out.push({ group, result: await evaluate(arr) });
  }
  return out;
}
