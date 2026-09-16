/**
 * 给纯英文**材料**补中文检索关键词：`npm run keywords`（加 --write 才落盘）
 *
 * 为什么需要它：中文查询命中纯英文材料的 recall@3 实测为 0%（见 CLAUDE.md 基线）。
 * 这些关键词写进 frontmatter 的 `keywords_zh`，与**标题**同理——模型给初值，本人可改
 * （见 CONTEXT.md 里「材料是否可修改」那条）。**绝不写进正文**：正文是来源原文，不可改。
 *
 * 长期看这一步应该在**收录**时就做掉；本脚本用于回填已有材料，以及在收录链路接上之前手动补。
 */
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { load } from "js-yaml";

import { resolveDataDir } from "../data-dir.js";
import { cjkRatio, generateChineseKeywords, needsChineseKeywords } from "../model/keywords.js";
import { initializeProxyAgent, loadEnv } from "../runtime.js";

loadEnv();
initializeProxyAgent();

const write = process.argv.includes("--write");
const dir = resolve(resolveDataDir(), "materials");
const names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();

let touched = 0;
for (const name of names) {
  const path = resolve(dir, name);
  const raw = await readFile(path, "utf8");
  // 只切前两个 ---，正文原样保留（含其中可能出现的 --- 分隔线）
  const parts = raw.split(/^---$/m);
  if (parts.length < 3) {
    console.warn(`跳过（frontmatter 格式异常）：${name}`);
    continue;
  }
  const fm = load(parts[1] ?? "") as { title?: string; keywords_zh?: unknown };
  const body = parts.slice(2).join("---");

  if (!needsChineseKeywords(body)) continue;
  if (Array.isArray(fm.keywords_zh) && fm.keywords_zh.length > 0) {
    console.log(`已有关键词，跳过：${fm.title}`);
    continue;
  }

  const kws = await generateChineseKeywords(fm.title ?? name, body);
  console.log(`${fm.title}（中文占比 ${(cjkRatio(body) * 100).toFixed(0)}%）`);
  console.log(`  → ${kws.join(" · ")}`);
  if (kws.length === 0) {
    console.warn("  ✗ 未取到关键词，跳过");
    continue;
  }
  touched++;
  if (!write) continue;

  // 只在 frontmatter 末尾追加一行，其余字节不动
  const fmText = (parts[1] ?? "").replace(/\n+$/, "");
  const line = `keywords_zh: [${kws.map((k) => JSON.stringify(k)).join(", ")}]`;
  const next = `---${fmText}\n${line}\n---${body}`;

  const tmp = `${path}.tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path); // 同一文件系统内 rename 是原子的
  console.log("  ✓ 已写入");
}

console.log(
  write
    ? `\n完成，改动 ${touched} 份材料。`
    : `\n这是预演（dry run），${touched} 份材料需要补。加 --write 才落盘。`,
);
