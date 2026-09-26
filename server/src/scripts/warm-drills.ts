/**
 * 预热全部**材料**的**练题**缓存。
 *
 *   npm run drills                  只读：报告每篇的缓存状态与题数，不调模型
 *   npm run drills -- --warm        提取「未缓存」的那些
 *   npm run drills -- --force       重新提取全部（某篇提歪了时用）
 *
 * 为什么要有这个脚本：见 CLAUDE.md「预练链路的实现约束」。**预练**标签列出全部材料，
 * 而未提取过的那些在列表里全是「未提取」——本人看不出哪篇有 52 道题、哪篇只有 5 道，
 * 而这恰好是「今晚练哪篇」需要的信息；且第一次点进去要等模型 10 多秒。
 * 成本形状与索引时翻译 / 查询提炼相同：调用次数 = 材料数（不是查询次数），
 * **材料**正文不可改 → 提取结果是正文的纯函数 → 永久缓存。预热只是把这些调用一口气做完。
 *
 * `warmAllDrills` 是可注入的核心逻辑（供测试用假 `extractFn` 替换，不触碰真实 DeepSeek）；
 * 下面的 `main()` 只是它的 CLI 薄包装。用 `import.meta.url` 守卫入口，
 * 使得测试 `import` 这个模块时不会连带跑起 CLI（不像 `push.ts` / `expand-index-page.ts`
 * 那样无条件执行 `main()`——那两个没有导出可测的核心函数，这个有，两者不冲突）。
 */

import {
  buildMaterialsIndex,
  listMaterials,
  type IndexedMaterial,
} from "../search/materials-index.js";
import { collectCandidateLines, buildDrills } from "../drills/anchor.js";
import { readCachedDrills, cacheDrills } from "../drills/cache.js";
import { extractDrills } from "../model/extract-drills.js";
import { initializeRuntime } from "../runtime.js";

/**
 * 并发上限。**这是保守值，不是测出来的**——`CLAUDE.md`「归属链路的实现约束」允许
 * 模型调用并发（不像抓取那样受站点限流约束），但服务商自己仍有速率限制，
 * 49 路材料一次性全发是在赌。4 只是「明显比 1 快、又不至于齐发」的直觉数字。
 */
const CONCURRENCY = 4;

/** 喂给 `extractDrills`（或注入的假函数）的候选行 → 练题原始结果。 */
type ExtractFn = (
  candidates: { line: number; text: string }[],
) => Promise<{ line: number; question: string }[]>;

export interface WarmResult {
  materialId: string;
  title: string;
  /** 提取出的练题数；null 表示本次尝试失败（两次都未取到合法结果），不是「零道题」 */
  count: number | null;
  /** 失败原因，原样保留 `extractDrills` 抛出的错误消息（带 finish_reason 与 token 数） */
  error?: string;
  /** true 表示命中缓存、本次未调用 extractFn */
  skipped: boolean;
  /** 这一篇花了多少毫秒。缓存命中时只是一次文件读，通常接近 0——用来和真实调用的耗时区分 */
  durationMs: number;
}

/**
 * 并发限制的简单任务队列：从 `items` 里按顺序取任务，最多同时跑 `limit` 个 worker。
 * 不引入第三方并发库（如 p-limit）——全仓库只有这一处需要"限并发"，
 * 几行队列够用，不值得为它加一个依赖。
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));

  async function runner(): Promise<void> {
    let next = queue.shift();
    while (next !== undefined) {
      await worker(next.item, next.index);
      next = queue.shift();
    }
  }

  const runnerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
}

/** 预热单份材料：命中缓存就跳过（除非 force），否则调 `extract` 提取并写缓存。 */
async function warmOne(
  material: IndexedMaterial,
  force: boolean,
  extract: ExtractFn,
): Promise<WarmResult> {
  const startedAt = Date.now();

  if (!force) {
    const cached = await readCachedDrills(material.id);
    if (cached !== null) {
      return {
        materialId: material.id,
        title: material.title,
        count: cached.length,
        skipped: true,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  try {
    const candidates = collectCandidateLines(material.markdown);
    const raw = await extract(candidates);
    const drills = buildDrills(material.id, material.markdown, raw);
    await cacheDrills(material.id, drills);
    return {
      materialId: material.id,
      title: material.title,
      count: drills.length,
      skipped: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // 一篇失败不能中断整批（下面 warmAllDrills 里每个 worker 独立捕获），
    // 原因原样保留——extractDrills 的错误消息里带着 finish_reason 和 token 数，
    // 那是专门为了定位问题加的，吞掉就白加了。
    return {
      materialId: material.id,
      title: material.title,
      count: null,
      error: err instanceof Error ? err.message : String(err),
      skipped: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * 预热全部**材料**的**练题**缓存。
 *
 * @param opts.force      true 时忽略已有缓存，全部重新提取
 * @param opts.onResult   每篇处理完（成功/失败/跳过之一）立刻调用一次，供 CLI 边跑边打
 * @param opts.extractFn  注入的模型调用；测试用假函数替换，默认是真实的 `extractDrills`
 */
export async function warmAllDrills(
  opts: {
    force?: boolean;
    onResult?: (r: WarmResult) => void;
    extractFn?: ExtractFn;
  } = {},
): Promise<WarmResult[]> {
  const extract = opts.extractFn ?? extractDrills;
  const force = opts.force ?? false;

  const index = await buildMaterialsIndex();
  const materials = listMaterials(index);

  const results: WarmResult[] = new Array(materials.length);

  await runWithConcurrency(materials, CONCURRENCY, async (material, i) => {
    const result = await warmOne(material, force, extract);
    results[i] = result;
    opts.onResult?.(result);
  });

  return results;
}

// ---- 下面是 CLI 薄包装 ----

/** 只是提示阈值，不是判断依据：题数是否"异常多"由本人自己看着决定要不要删缓存重跑。 */
const MEDIAN_MULTIPLE_FOR_FLAG = 3;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1];
    const right = sorted[mid];
    if (left !== undefined && right !== undefined) return (left + right) / 2;
  }
  return sorted[mid] ?? 0;
}

function formatCount(count: number): string {
  return `${String(count).padStart(4, " ")} 道`;
}

/** 只读模式：`npm run drills`。逐篇报告缓存状态与题数，不调模型、不落盘。 */
async function reportReadOnly(): Promise<void> {
  const index = await buildMaterialsIndex();
  const materials = listMaterials(index);

  const rows: { title: string; count: number | null }[] = [];
  for (const material of materials) {
    const cached = await readCachedDrills(material.id);
    rows.push({ title: material.title, count: cached === null ? null : cached.length });
  }

  const counts: number[] = [];
  for (const row of rows) {
    if (row.count !== null) counts.push(row.count);
  }
  const med = median(counts);

  for (const row of rows) {
    if (row.count === null) {
      console.log(`  未提取  ${row.title}`);
      continue;
    }
    const zeroMark = row.count === 0 ? "   ← 零" : "";
    const abnormalMark =
      med > 0 && row.count > med * MEDIAN_MULTIPLE_FOR_FLAG ? "   ← 异常多（提示，非阈值）" : "";
    console.log(`${formatCount(row.count)}  ${row.title}${zeroMark}${abnormalMark}`);
  }

  const cachedTotal = counts.length;
  const totalDrills = counts.reduce((a, b) => a + b, 0);
  console.log(
    `\n共 ${materials.length} 篇：已缓存 ${cachedTotal} / 未提取 ${materials.length - cachedTotal}` +
      (cachedTotal > 0 ? `，已缓存题共 ${totalDrills} 道` : "") +
      "。想提取未缓存的跑 `npm run drills -- --warm`。",
  );
}

/** `--warm` / `--force` 模式：实际调模型提取，边跑边打。 */
async function runWarmMode(force: boolean): Promise<void> {
  console.log(force ? "[预热] 重新提取全部材料……\n" : "[预热] 提取未缓存的材料……\n");

  const results = await warmAllDrills({
    force,
    onResult: (r) => {
      const elapsed = `${(r.durationMs / 1000).toFixed(1)}s`;
      if (r.error !== undefined) {
        console.log(`  失败  ${r.title}`);
        console.log(`        ${r.error}`);
        return;
      }
      const count = r.count ?? 0;
      const zeroMark = count === 0 ? "   ← 零" : "";
      // 变量名刻意避开 `tag`：ADR-0001 的机械检查是零容忍的
      // （`grep -rniE "\btag\b|\btopic\b|\bcategory\b|知识点" server/src` 应无输出）。
      // 留一个无害的同名局部变量会把基线从 0 抬到 2，下次真违规就藏在噪音里。
      const suffix = r.skipped ? "（缓存）" : elapsed;
      console.log(`${formatCount(count)}  ${r.title}${zeroMark}  ${suffix}`);
    },
  });

  const skippedCount = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error !== undefined);
  const extractedCount = results.length - skippedCount - failed.length;

  const counts: number[] = [];
  for (const r of results) {
    if (r.count !== null) counts.push(r.count);
  }
  const totalDrills = counts.reduce((a, b) => a + b, 0);
  const med = median(counts);

  const zeros = results.filter((r) => r.count === 0);
  const abnormal =
    med > 0
      ? results.filter((r) => r.count !== null && r.count > med * MEDIAN_MULTIPLE_FOR_FLAG)
      : [];

  console.log(
    `\n完成：共 ${results.length} 篇 / 缓存命中跳过 ${skippedCount} / 本次提取 ${extractedCount} / ` +
      `失败 ${failed.length} / 总题数 ${totalDrills}`,
  );

  if (zeros.length > 0) {
    console.log(
      `\n0 道的材料（${zeros.length} 篇。缓存永久有效，怀疑提歪了就删 .cache/drills-<材料id>.json，再用 --force 重跑那一篇所在的批次）：`,
    );
    for (const r of zeros) console.log(`  - ${r.title}`);
  }

  if (abnormal.length > 0) {
    console.log(
      `\n题数明显偏多的材料（超过中位数 ${MEDIAN_MULTIPLE_FOR_FLAG} 倍，只是提示，不是判断依据）：`,
    );
    for (const r of abnormal) console.log(`  - ${r.title}（${r.count} 道）`);
  }

  if (failed.length > 0) {
    console.log(`\n失败清单：`);
    for (const r of failed) console.log(`  - ${r.title}：${r.error}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  initializeRuntime();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const warm = args.includes("--warm");

  if (force) {
    await runWarmMode(true);
  } else if (warm) {
    await runWarmMode(false);
  } else {
    await reportReadOnly();
  }
}

// 只有直接执行这个脚本（`tsx src/scripts/warm-drills.ts`）时才跑 CLI；
// 被测试 `import` 时 `process.argv[1]` 是测试运行器的路径，两者不会相等。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[预热] 错误：", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
