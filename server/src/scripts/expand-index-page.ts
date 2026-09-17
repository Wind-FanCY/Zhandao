/**
 * 展开**索引页**：`npm run expand -- <索引页URL>` （加 `--dry-run` 只预览不落盘）
 *
 * ADR-0010：**索引页**本身不成为**材料**（无内容，不够格），但它展开出的每份**材料**
 * 在 frontmatter 里用 `from` 记下是哪个索引页展开了它——这是事实，不是分类，不进图谱。
 *
 * 与**收件箱**过闸的关系：这里的候选集不是 Chrome 书签夹，而是索引页里同前缀的 `.html`
 * 链接；但正文抽取、退避重试、失败分类完全复用 `extractArticles`，落盘规则也和过闸一致——
 * **抽取失败的条目不进 `materials/`**（CLAUDE.md），不建跨会话的「待处理」队列：
 * 这个脚本一次跑完，失败清单只打印在这次的输出里，不落盘、不记待处理状态。
 *
 * 幂等：已经在 `processed.jsonl` 里出现过的 URL 会被跳过，重跑不会重复收录。
 *
 * 刻意不调用模型：这 41 篇是中文，`keywords_zh` 是给纯英文材料补中文检索关键词用的，
 * 用不上；「收录时自动生成关键词」本身还在开放项里，不该在这个脚本里抢先做。
 */
import { extractArticles, USER_AGENT } from "../inbox/extract.js";
import { writeMaterial } from "../materials/write.js";
import { appendProcessed, readProcessedUrls } from "../inbox/processed.js";
import { enumerateSameFolderLinks } from "./index-page-links.js";
import { initializeRuntime } from "../runtime.js";

initializeRuntime();

/**
 * 抓索引页的原始 HTML（不经 Readability——我们要的是完整 DOM 里的 `<a>` 标签，
 * 而 Readability 是为「抽正文」设计的，会把侧边栏/目录当噪音删掉，ADR-0010 已经
 * 记录过这一点：那 41 条链接不在材料正文里，必须重新抓索引页本身）。
 *
 * 请求头与 `extract.ts` 保持一致：完整浏览器 UA + Accept + Accept-Language + Referer，
 * 否则和过闸链路一样会被部分站点当成非浏览器请求处理。
 */
async function fetchIndexPageHtml(url: string): Promise<string> {
  const refererOrigin = new URL(url).origin;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Referer": refererOrigin,
    },
  });
  if (!response.ok) {
    throw new Error(`抓取索引页失败：HTTP ${response.status}`);
  }
  return response.text();
}

async function main() {

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const indexUrl = args.find((a) => !a.startsWith("--"));

  if (!indexUrl) {
    console.error('用法：npm run expand -- "<索引页URL>" [--dry-run]');
    process.exit(1);
  }

  console.log(`[展开] 索引页：${indexUrl}`);
  const html = await fetchIndexPageHtml(indexUrl);

  const allLinks = enumerateSameFolderLinks(html, indexUrl);
  console.log(`[展开] 发现 ${allLinks.length} 条同前缀 .html 链接`);

  const processed = await readProcessedUrls();
  const skipped = allLinks.filter((u) => processed.has(u));
  const urls = allLinks.filter((u) => !processed.has(u));

  if (dryRun) {
    console.log(
      `\n[dry-run] 不抓取、不落盘。将收录 ${urls.length} 条（已跳过 ${skipped.length} 条已处理过的）：\n`,
    );
    for (const u of urls) console.log(`  ${u}`);
    return;
  }

  if (urls.length === 0) {
    console.log(`\n没有新链接需要收录（${skipped.length} 条已处理过）。`);
    return;
  }

  const startedAt = Date.now();
  console.log(`\n[展开] 开始抓取 ${urls.length} 条链接（顺序、带间隔、带退避重试）...\n`);

  // 复用 extractArticles：顺序抓取、1.5 秒间隔、浏览器请求头、退避重试、编码嗅探都在里面，
  // 这里只负责「逐条打印进度」和之后的落盘决策。
  const items = await extractArticles(urls, {
    onItem: (item) => {
      if (item.result.ok) {
        console.log(`  ✓ ${item.url}`);
      } else {
        console.log(`  ✗ ${item.url} — ${item.result.reason}: ${item.result.detail}`);
      }
    },
  });

  let kept = 0;
  const failures: { url: string; reason: string; detail: string }[] = [];

  for (const item of items) {
    if (item.result.ok) {
      const written = await writeMaterial({
        title: item.result.title,
        markdown: item.result.markdown,
        source: item.result.finalUrl,
        from: indexUrl,
      });
      // 决策日志记原始链接（enumerateSameFolderLinks 收上来的那个），不是 finalUrl——
      // 幂等检查（readProcessedUrls）也是拿原始链接去比对，两处必须用同一个 key。
      await appendProcessed({
        url: item.url,
        decision: "kept",
        at: new Date().toISOString(),
        materialId: written.id,
      });
      kept += 1;
    } else {
      // 抽取失败的条目不进 materials/，也不记进 processed.jsonl——
      // 不建跨会话的「待处理」队列，失败清单只在这次运行的输出里，本人当场决定
      // 手动补正文还是划掉（划掉的话下次重跑仍会抓到它，需要另外处理）。
      failures.push({ url: item.url, reason: item.result.reason, detail: item.result.detail });
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n完成：成功 ${kept} / 失败 ${failures.length} / 跳过 ${skipped.length}，耗时 ${elapsedSec}s`,
  );

  if (failures.length > 0) {
    console.log("\n失败清单：");
    for (const f of failures) {
      console.log(`  ✗ ${f.url}`);
      console.log(`      ${f.reason}: ${f.detail}`);
    }
  }
}

main().catch((err) => {
  console.error("[展开] 错误：", err instanceof Error ? err.message : err);
  process.exit(1);
});
