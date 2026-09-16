/**
 * 清理任意文本，使其适合用作文件名的一段。
 *
 * 原先只在 materials/write.ts 里为标题服务（写死上限 60）；
 * annotations/write.ts 需要同样的规则、但摘要上限是 24，
 * 于是把上限提成参数，规则本身一字不改。
 *
 * 规则：
 * - 保留中文字符原样
 * - 去掉 / \ : * ? " < > | 和控制字符
 * - 空白折叠成单个 -
 * - 截断到 maxLen 个字符
 * - 清理后为空则返回空字符串
 */
export function sanitizeForFilename(text: string, maxLen: number): string {
  // 去掉不合法的字符
  let cleaned = text.replace(/[\\/:"*?<>|]|[\x00-\x1f]/g, "");

  // 空白折叠
  cleaned = cleaned.replace(/\s+/g, "-");

  // 截断
  cleaned = cleaned.substring(0, maxLen);

  // 去掉首尾的 -
  cleaned = cleaned.replace(/^-+|-+$/g, "");

  return cleaned;
}
