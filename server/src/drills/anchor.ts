/**
 * **练题**的候选行收集与构造——纯函数，无 IO。见 CLAUDE.md「预练链路的实现约束」与 ADR-0011。
 *
 * 「提取而非生成」不能只靠 prompt 维持，必须是机械可验证的不变量。**2026-09-19 改法**：
 * 不再把全文喂给模型、事后检查它转录的 anchor 能不能在正文里定位到（旧版做法），
 * 而是反过来——先机械枚举正文里所有「候选行」（标题行、整行加粗行），只把这些行喂给模型，
 * 模型只能从给出的行号里挑。这样模型连编一道没有锚点的题的物理可能性都没有：
 * 不变量从**事后检查**变成**由构造保证**，顺带把「模型转录锚点转录错、三级模糊匹配都救不回来」
 * 这整个失效模式消掉了（原实现靠三级归一化容忍模型转录误差，那套匹配逻辑现在不需要了）。
 *
 * 这不是退回 ADR-0011 明确否决过的纯机械提取：机械只负责**枚举候选位置**，
 * 哪些候选值得练、问题怎么问，仍然由模型判断（`model/extract-drills.ts`）。
 *
 * **id 为什么必须是 `(材料, 锚点)` 的纯函数，而不能是 ULID / 随机值**：
 * **练题记录**是不可再生的真实数据、住 `data/`；**练题清单**是可丢弃派生物、住 `.cache/`
 * （ADR-0003）。如果 id 依赖生成时刻的随机性，删一次 `.cache/` 重新提取后 id 全部对不上，
 * 之前记的**练题记录**就全部变成孤儿——`data/` 里的东西不该因为删了 `.cache/` 就报废。
 * 用 `材料id#锚点slug` 做 id，只要正文不变（CONTEXT.md：正文不可改），
 * 同一个锚点重新提取永远得到同一个 id。
 */

export interface Drill {
  id: string; // `${materialId}#${slug}`
  materialId: string;
  question: string; // 给人看的问题
  anchor: string; // 正文里逐字存在的那一行
  anchorLine: number; // 0-based 行号
}

/** 材料正文里常见的自链接标题前缀，如 `[#](#get-和-post-有什么区别)`。与标题标记一起剥掉。 */
const HEADING_MARK_RE = /^#{1,6}\s*/;
const SELF_LINK_RE = /\[#\]\(#[^)]*\)\s*/g;
/** 「字母数字中日韩字符」之外的字符：拉丁字母/数字、中文、日文假名、韩文音节块之外的都算分隔符 */
const NON_WORD_RE = /[^a-zA-Z0-9一-鿿぀-ヿ가-힯]+/g;

/** 标题行：`#` 到 `######`，后跟至少一个空白。 */
const HEADING_LINE_RE = /^#{1,6}\s/;
/** 整行加粗行：从 `**` 开始、以 `**` 结尾（中间允许任意字符），前后允许空白。 */
const BOLD_LINE_RE = /^\*\*.*\*\*\s*$/;

/**
 * 机械枚举材料正文里的全部候选行：标题行 + 整行加粗行。
 *
 * 这是「提取而非生成」这条不变量的构造侧——喂给模型的只有这些行，
 * 模型返回的 line 若不在这个集合里，`buildDrills` 会直接丢弃，不做任何猜测式的模糊匹配。
 * `text` 取原始行（不 trim），保证后续 `anchor` 与正文逐字一致。
 */
export function collectCandidateLines(markdown: string): { line: number; text: string }[] {
  const lines = markdown.split("\n");
  const candidates: { line: number; text: string }[] = [];

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (HEADING_LINE_RE.test(trimmed) || BOLD_LINE_RE.test(trimmed)) {
      candidates.push({ line: i, text: line });
    }
  }

  return candidates;
}

/**
 * 把一行 anchor 文本变成 slug：去标题标记、去自链接前缀、非字母数字中日韩字符替换成 `-`、
 * 压缩连续 `-`、去首尾 `-`、截断 60 字符。
 */
export function slugForAnchor(anchor: string): string {
  let s = anchor;
  s = s.replace(HEADING_MARK_RE, "");
  s = s.replace(SELF_LINK_RE, "");
  s = s.replace(NON_WORD_RE, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s.slice(0, 60);
}

/**
 * 把模型提取出的原始 `{line, question}` 列表变成校验过的 `Drill[]`。
 *
 * - `line` 不在 `collectCandidateLines(markdown)` 枚举出的候选集里——丢弃。
 *   这是机械不变量本身，不是「尽力保留」：模型只能从候选行里挑，挑了候选集之外的
 *   行号只可能是编造或算错，两种情况都不该进入**练题**清单。
 * - `question` 为空串——丢弃。
 * - `anchor` 永远取候选集里那一行的原文（由我们查表取得），不是模型转录的任何文本，
 *   所以「anchor 与正文逐字一致」从「事后检查」变成「构造上不可能不一致」。
 * - 保持模型给出的顺序。
 * - slug 冲突时（同一材料里两个锚点归一化成同一个 slug）追加 `-2` / `-3` ……
 */
export function buildDrills(
  materialId: string,
  markdown: string,
  raw: { line: number; question: string }[],
): Drill[] {
  const candidates = collectCandidateLines(markdown);
  const lineToText = new Map(candidates.map((c) => [c.line, c.text]));

  const drills: Drill[] = [];
  const slugCounts = new Map<string, number>();

  for (const item of raw) {
    if (item.question.trim().length === 0) continue; // 空问题——丢弃

    const text = lineToText.get(item.line);
    if (text === undefined) continue; // 不在候选集里——丢弃，机械不变量，不是「尽力保留」

    const baseSlug = slugForAnchor(text) || "anchor"; // 极端情况下 slug 为空的兜底
    const seen = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, seen + 1);
    const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;

    drills.push({
      id: `${materialId}#${slug}`,
      materialId,
      question: item.question,
      anchor: text, // 逐字取自正文，不是模型给的任何文本
      anchorLine: item.line,
    });
  }

  return drills;
}
