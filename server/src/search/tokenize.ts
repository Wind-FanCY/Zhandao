/**
 * 文本分词模块。
 *
 * 策略：拉丁词项小写；CJK 可配置单字 + 二字组。
 *
 * **CJK 的可配置性**：
 * 实测（2026-09-16，10 条评估集）发现「只要二字组、丢单字」能把 recall@1 从 60% 提到 70%。
 * 但那个改进在 10 条样本里只相当于 1 条，在噪音范围内。
 * 因此**默认值仍是两者都开**（更保守），但做成可开关便于将来评估集够大时正确实测。
 *
 * 见 CLAUDE.md 的「两条实测结论」：分词与停用词是第一个该调的。
 * 不在此模块调整停用词——那个决策需要评估集支撑，现在调就是过拟合。
 *
 * **跨语言 gap**：纯英文材料对中文查询 recall@1=0%，而中文材料是 100%。
 * 这是跨语言问题，**只能靠模型解决**（查询改写或向量），不是分词能处理的。
 */

export interface TokenizeOptions {
  /** CJK 单字，默认 true */
  cjkUnigram?: boolean;
  /** CJK 相邻二字组，默认 true */
  cjkBigram?: boolean;
}

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
 * 2. CJK 单字 → 一个词项（如果 cjkUnigram 为真）
 * 3. CJK 相邻二字组 → 一个词项（如果 cjkBigram 为真）
 * 4. 标点、空白 → 忽略，不产生空词项
 *
 * @param text 输入文本
 * @param options 分词选项，默认 { cjkUnigram: true, cjkBigram: true }
 *
 * 示例（默认选项）：
 * - "Promise 面试题" → ["promise", "面", "试", "题", "面试", "试题"]
 * - "HTTP_PROXY 代理" → ["http_proxy", "代", "理", "代理"]
 * - "HTTP_PROXY代理" → ["http_proxy", "代", "理", "代理"]
 */
export function tokenize(text: string, options?: TokenizeOptions): string[] {
  const opts = {
    cjkUnigram: true,
    cjkBigram: true,
    ...options,
  };

  const tokens: string[] = [];
  const cjkTokens: string[] = []; // 仅存 CJK 单字，用于生成二字组

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
      if (opts.cjkUnigram) {
        tokens.push(char);
      }
      cjkTokens.push(char);
      i++;
    }
    // 其他字符（标点、空白）跳过
    else {
      i++;
    }
  }

  // 生成 CJK 二字组（如果启用）
  const bigrams: string[] = [];
  if (opts.cjkBigram && cjkTokens.length > 1) {
    for (let j = 0; j < cjkTokens.length - 1; j++) {
      const curr = cjkTokens[j];
      const next = cjkTokens[j + 1];
      if (curr && next) {
        bigrams.push(curr + next);
      }
    }
  }

  // 合并所有词项
  return [...tokens, ...bigrams];
}
