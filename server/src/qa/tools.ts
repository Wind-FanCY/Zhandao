/**
 * **问答**循环能调用的三个工具：search / outline / read。纯函数，不碰模型、不碰文件系统
 * ——它们只是对已经建好的 `MaterialsIndex` 做只读查询，供 `qa/loop.ts` 编排调用。
 *
 * 三个工具对应"召回三档强度"里"被迫调用"那一档，但内部用的仍然是 BM25 检索
 * （`searchMaterials`），不是另起一套；**问答链路本身不写任何数据**，与
 * CLAUDE.md「归属链路的实现约束」里"v1 不把标注加进检索索引"的基线保持一致，
 * 这里也不例外。
 */

import { getMaterial, searchMaterials, type MaterialsIndex } from "../search/materials-index.js";
import { collectCandidateLines } from "../drills/anchor.js";

export interface ToolContext {
  index: MaterialsIndex;
}

export interface SearchHit {
  materialId: string;
  title: string;
  from?: string;
  score: number;
}

const DEFAULT_SEARCH_LIMIT = 5;

/**
 * 检索材料。**只返回 id / 标题 / 来源 / 分数，绝不把 `markdown` 全文带出去**——
 * 模型这一步只需要知道"有哪些候选、大概是什么"，全文交给后面的 outline/read 按需再拿，
 * 否则每次 search 都把全部候选材料的正文塞进对话历史，几轮之内就把 context 撑爆。
 */
export function toolSearch(ctx: ToolContext, query: string, limit: number = DEFAULT_SEARCH_LIMIT): SearchHit[] {
  return searchMaterials(ctx.index, query, limit).map((m) => ({
    materialId: m.id,
    title: m.title,
    from: m.from,
    score: m.score,
  }));
}

/**
 * 与 `collectCandidateLines` 的返回元素形状逐字相同——它没有导出一个专门的类型
 * （返回类型是内联的 `{ line: number; text: string }[]`），这里补一个具名类型只是
 * 为了契约里 `toolOutline` 的签名可读，不代表两边形状会分叉：分叉了 TS 会在
 * `collectCandidateLines(material.markdown)` 这行直接报类型错误。
 */
export interface OutlineEntry {
  line: number;
  text: string;
}

/**
 * 展开一份材料的大纲：全部标题行 + 全部整行加粗行，各带行号。
 *
 * 直接复用 `collectCandidateLines`——它已经是"预练"链路验证过的机械枚举逻辑，
 * 这里的用途不同（给模型当"这份材料里有哪些位置可以 read"的地图，而不是给模型出题），
 * 但"枚举候选位置"这件事本身没有变化，没有理由另写一套正则。
 */
export function toolOutline(
  ctx: ToolContext,
  materialId: string,
): { title: string; entries: OutlineEntry[] } | null {
  const material = getMaterial(ctx.index, materialId);
  if (!material) return null;

  return { title: material.title, entries: collectCandidateLines(material.markdown) };
}

/** 标题行：`#` 到 `######`，后跟至少一个空白；返回级别（1-6），不是标题行返回 null。 */
const HEADING_LEVEL_RE = /^(#{1,6})\s/;
const FENCE_RE = /^(```|~~~)/;

/**
 * 标出每一行是否落在代码围栏内部。
 *
 * **不加这个的话 `toolRead` 会在代码块中间把正文切断。** 实测本库 49 篇材料里有 3 篇、
 * 共 25 行是围栏内的 shell 提示符注释（`# netstat -s | grep overflowed`、`# ifconfig eth0`），
 * 它们全是**一级**——`lvl <= startLevel` 对任何起始层级都成立，所以必然成为边界。
 * 具体后果：读「4.22 用了 TCP 协议，数据一定不会丢吗？」里带 netstat 示例的小节时，
 * 原文会在命令行注释处被砍掉，而被砍掉的恰好是解释那条命令的部分。
 *
 * **`drills/anchor.ts` 的 `collectCandidateLines` 有同一个盲点，这次刻意不一起改**：
 * 那边的后果只是多出几个候选行，而模型被要求跳过不构成题目的行，且**练题清单住 `.cache/`**
 * 可随时重生成；这边的后果是答案原料被静默截断。**一次只改一个地方，别搭车。**
 */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? "";
    if (FENCE_RE.test(t)) {
      // 围栏标记行本身不算正文标题，两侧都标成"在围栏里"最省事
      mask[i] = true;
      inside = !inside;
      continue;
    }
    mask[i] = inside;
  }
  return mask;
}

function headingLevel(line: string | undefined): number | null {
  if (line === undefined) return null;
  const match = HEADING_LEVEL_RE.exec(line.trim());
  // `noUncheckedIndexedAccess` 下 match[1] 类型是 string | undefined，
  // 即便正则捕获组按定义必然匹配到内容——用 `?.` 而不是断言收窄
  return match ? (match[1]?.length ?? null) : null;
}

/**
 * `toolRead` 单段原文的硬上限。存在的理由：某些材料的一节可以长到近四万字符
 * （见 CLAUDE.md「技术路线」切块一节，Promise 那篇按 h2 切最大块 39700 字符），
 * 不设上限会有单次 read 直接把整轮对话的 token 预算吃光的风险。
 */
const MAX_READ_LENGTH = 4000;
const TRUNCATION_SUFFIX = "…（本段已截断）";

/**
 * 读一份材料从 `line` 这一行开始的一段原文，切到**下一个同级或更高级标题**为止；
 * 起始行本身不是标题时，切到**下一个任意标题**为止（没有更小的级别可比较）。
 *
 * 例：起始行是 `## 标题`（级别 2），往下找到的第一个 `#`/`##` 就是边界（`###` 不算，
 * 那是更细的子节，仍属于这一段）；起始行是正文里随便一行，找到的第一个任意标题
 * （不管几级）就是边界——因为非标题行没有"级别"可言，谈不上"同级或更高级"。
 *
 * 材料不存在或行号越界（`line < 0` 或 `line >= 总行数`）返回 `null`。
 */
export function toolRead(
  ctx: ToolContext,
  materialId: string,
  line: number,
): { title: string; text: string } | null {
  const material = getMaterial(ctx.index, materialId);
  if (!material) return null;

  const lines = material.markdown.split("\n");
  if (line < 0 || line >= lines.length) return null;

  const fenced = fenceMask(lines);
  const startLevel = fenced[line] ? null : headingLevel(lines[line]);

  let endIdx = lines.length; // 默认切到文末——后面没有边界标题时就读到底
  for (let i = line + 1; i < lines.length; i++) {
    if (fenced[i]) continue; // 围栏内的 `#` 是 shell 注释，不是标题（见 fenceMask）
    const lvl = headingLevel(lines[i]);
    if (lvl === null) continue; // 不是标题行，不构成边界，继续往下找
    if (startLevel === null || lvl <= startLevel) {
      endIdx = i;
      break;
    }
  }

  let text = lines.slice(line, endIdx).join("\n");
  if (text.length > MAX_READ_LENGTH) {
    text = text.slice(0, MAX_READ_LENGTH) + TRUNCATION_SUFFIX;
  }

  return { title: material.title, text };
}
