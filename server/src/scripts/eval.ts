/**
 * 检索评估：`npm run eval`
 *
 * CLAUDE.md 的 RAG 四阶段要求每阶段对基线量化。这个脚本就是那把尺子，
 * 所以它是长期存在的代码，不是一次性探针。
 *
 * 评估集在 `data/eval/retrieval.jsonl`——它编码「什么算对」，属于本人的判断，
 * 因此住在数据仓库而非代码仓库。
 */
import { evaluate, evaluateByLanguage, evaluateByOrigin, readEvalSet } from "../search/eval.js";
import { initializeRuntime } from "../runtime.js";

initializeRuntime();

const cases = await readEvalSet();
if (cases.length === 0) {
  console.error("评估集为空或不存在：data/eval/retrieval.jsonl");
  process.exit(1);
}

const fmt = (r: { recallAt1: number; recallAt3: number; mrr: number; total: number }) =>
  `n=${String(r.total).padStart(2)}  recall@1=${(r.recallAt1 * 100).toFixed(0).padStart(3)}%` +
  `  recall@3=${(r.recallAt3 * 100).toFixed(0).padStart(3)}%  MRR=${r.mrr.toFixed(3)}`;

const overall = await evaluate(cases);
console.log(`整体      ${fmt(overall)}`);
console.log(`          排名 ${JSON.stringify(overall.ranks)}\n`);

console.log("按目标材料语言分组（聚合指标会掩盖跨语言 gap，见 CLAUDE.md）：");
for (const { group, result } of await evaluateByLanguage(cases)) {
  console.log(`  ${group}  ${fmt(result)}  排名 ${JSON.stringify(result.ranks)}`);
}

console.log("\n按查询来源分组（这份评估集最大的偏差是「查询是我猜的」）：");
for (const { group, result } of await evaluateByOrigin(cases)) {
  // 少于 5 条时任何差距都在噪音里，标出来免得被当成结论
  const warn = result.total < 5 ? "   ← 样本太少，只看趋势" : "";
  console.log(`  ${group}  ${fmt(result)}${warn}`);
}

if (overall.misses.length > 0) {
  console.log(`\n未命中第一名的 ${overall.misses.length} 条：`);
  for (const m of overall.misses) {
    console.log(`  排名 ${m.rank}  ${m.query}`);
    console.log(`      期望: ${m.expectTitle}`);
    console.log(`      实际第一: ${m.topTitle}`);
  }
}
