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
export type EvalCase = {
  query: string;
  expect: string;
  expect_title?: string;
  /** 句式：短问句还是长口语句。n=20 时两者无差别，留着这个字段是为了样本变多后能重测 */
  kind?: "short" | "oral";
  /**
   * 这条查询是谁写的。`guessed` = 我猜本人会这么问，`real_note` = 本人真写下的**速记**原文。
   *
   * **为什么必须记**：这份评估集最大的偏差就是「查询是猜的」，而偏差看不见就会被当成不存在。
   * 把它变成一个分组维度，每次跑 `npm run eval` 都会把「猜的 n=30 / 真的 n=1」摊在眼前。
   * 缺省按 `guessed` 算——保守方向：不把来源不明的样本当成真实证据。
   */
  origin?: "guessed" | "real_note";
};

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
async function evaluateGroups(
  cases: EvalCase[],
  keyOf: (c: EvalCase) => Promise<string>,
): Promise<{ group: string; result: EvalResult }[]> {
  const buckets = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const group = await keyOf(c);
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

export async function evaluateByLanguage(
  cases: EvalCase[],
): Promise<{ group: string; result: EvalResult }[]> {
  const index = await buildMaterialsIndex();
  return evaluateGroups(cases, async (c) => {
    const target = getMaterial(index, c.expect);
    if (!target) return "未知";
    return (await cjkRatio(target.path)) < 0.05 ? "纯英文材料" : "含中文材料";
  });
}

/**
 * 按查询的来源分组：我猜的 vs 本人真写的**速记**。
 *
 * **为什么必须分组**：2026-09-16 实测，原有 10 条（全是猜的、且是对着库调出来的）
 * recall@3=100%，而新起草的 20 条只有 65%——差 35 个百分点。
 * 同一把尺子、同一个索引，差别只在「查询是谁写的」。
 * 这个分组的作用是让这道偏差一直可见，而不是每隔几周重新发现一次。
 */
export async function evaluateByOrigin(
  cases: EvalCase[],
): Promise<{ group: string; result: EvalResult }[]> {
  return evaluateGroups(cases, async (c) =>
    c.origin === "real_note" ? "本人真写的速记" : "我猜的查询",
  );
}
