/**
 * 文本分词模块。
 *
 * 策略：拉丁词项小写；CJK 切单字 + 相邻二字组。
 * 理由见 CLAUDE.md 的「两条实测结论」：分词与停用词是第一个该调的，
 * 单字 + 二字组会让功能词变成信号（长文档虚高），但这是后续优化的基础。
 *
 * 不在此模块调整停用词——那个决策需要评估集支撑，现在调就是过拟合。
 */

/**
 * 判断字符是否 CJK（汉字、日文、韩文）。
 *
 * Unicode 范围：
 * - CJK Unified Ideographs: U+4E00 - U+9FFF
 * - CJK Unified Ideographs Extension A: U+3400 - U+4DBF
 * - CJK Unified Ideographs Extension B: U+20000 - U+2A6DF
 * - Hiragana: U+3040 - U+309F
 * - Katakana: U+30A0 - U+30FF
 * - Hangul: U+AC00 - U+D7AF
 */
function isCJK(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * 判断字符是否拉丁词项的一部分（字母、数字、下划线）。
 * 下划线保留是为了不切开 `http_proxy` 这样的标识符。
 */
function isLatinChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

/**
 * 把文本切成检索词项。
 *
 * 处理规则：
 * 1. 拉丁连续段（[a-zA-Z0-9_]+）→ 小写后作为一个词项
 * 2. CJK 单字 → 一个词项
 * 3. CJK 相邻二字组 → 一个词项（在单字之后）
 * 4. 标点、空白 → 忽略，不产生空词项
 *
 * 示例：
 * - "Promise 面试题" → ["promise", "面", "试", "题", "面试", "试题"]
 * - "HTTP_PROXY 代理" → ["http_proxy", "代", "理", "代理"]
 * - "HTTP_PROXY代理" → ["http_proxy", "代", "理", "代理"]
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);

    // 拉丁连续段
    if (isLatinChar(char)) {
      let word = "";
      while (i < text.length && isLatinChar(text.charAt(i))) {
        word += text.charAt(i);
        i++;
      }
      tokens.push(word.toLowerCase());
    }
    // CJK 单字
    else if (isCJK(char)) {
      tokens.push(char);
      i++;
    }
    // 其他字符（标点、空白）跳过
    else {
      i++;
    }
  }

  // 生成 CJK 二字组
  // 遍历已有的词项，相邻的两个 CJK 单字组成二字组
  const bigrams: string[] = [];
  for (let j = 0; j < tokens.length - 1; j++) {
    const curr = tokens[j];
    const next = tokens[j + 1];
    // 两个都是单字且都是 CJK
    if (curr && next && curr.length === 1 && next.length === 1 && isCJK(curr) && isCJK(next)) {
      bigrams.push(curr + next);
    }
  }

  // 合并单字和二字组
  return [...tokens, ...bigrams];
}
