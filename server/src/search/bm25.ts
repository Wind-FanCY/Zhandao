/**
 * BM25 检索算法实现。
 *
 * 纯函数式、内存中的索引，便于测试和序列化。
 * 不依赖任何外部库（特别是不用 lunr、flexsearch、minisearch）。
 *
 * 算法：标准 BM25，idf = log(1 + (N - df + 0.5) / (df + 0.5))
 */

import { tokenize } from "./tokenize.js";

export interface Doc {
  id: string;
  text: string;
}

export interface Bm25Params {
  /** 词频饱和度，默认 1.5 */
  k1?: number;
  /** 长度归一化强度，默认 0.75 */
  b?: number;
}

export interface Hit {
  id: string;
  score: number;
}

/** 内部：文档的统计信息 */
interface DocStats {
  id: string;
  length: number;
  frequencies: Map<string, number>;
}

/** 内部：词项的统计信息 */
interface TermStats {
  df: number;
  idf: number;
}

/** BM25 索引的公开接口（不暴露内部实现） */
export interface Bm25Index {
  readonly _docCount: number;
  readonly _avgDocLength: number;
  readonly _docs: Map<string, DocStats>;
  readonly _termStats: Map<string, TermStats>;
}

/**
 * 建立 BM25 索引。
 *
 * 计算所有词项的 IDF、文档长度、频率等。
 * 文档列表为空时返回空索引。
 */
export function buildIndex(docs: Doc[]): Bm25Index {
  const docsList: DocStats[] = [];
  const termStats = new Map<string, TermStats>();

  // 第一遍：分词、计算频率、收集词项的 df
  const termDocSets = new Map<string, Set<string>>();

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const frequencies = new Map<string, number>();

    // 计算词频
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }

    docsList.push({
      id: doc.id,
      length: tokens.length,
      frequencies,
    });

    // 记录哪些文档包含这个词（用于 df）
    for (const term of frequencies.keys()) {
      if (!termDocSets.has(term)) {
        termDocSets.set(term, new Set());
      }
      termDocSets.get(term)!.add(doc.id);
    }
  }

  // 计算 IDF
  const N = docs.length;
  for (const [term, docSet] of termDocSets) {
    const df = docSet.size;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    termStats.set(term, { df, idf });
  }

  // 计算平均文档长度
  const totalLength = docsList.reduce((sum, doc) => sum + doc.length, 0);
  const avgDocLength = docsList.length > 0 ? totalLength / docsList.length : 0;

  // 构建索引
  const docsMap = new Map(docsList.map((doc) => [doc.id, doc]));

  return {
    _docCount: N,
    _avgDocLength: avgDocLength,
    _docs: docsMap,
    _termStats: termStats,
  };
}

/**
 * 在索引中检索。
 *
 * @param index BM25 索引
 * @param query 查询文本
 * @param limit 返回结果数量限制，0 表示无限制
 * @param params BM25 参数（k1, b）
 * @returns 按分数降序的命中列表，分数为 0 的不返回
 */
export function search(
  index: Bm25Index,
  query: string,
  limit: number = 0,
  params: Bm25Params = {},
): Hit[] {
  const k1 = params.k1 ?? 1.5;
  const b = params.b ?? 0.75;

  // 分词
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  // 计算每个文档的分数
  const scores = new Map<string, number>();

  for (const [docId, docStats] of index._docs) {
    let score = 0;

    for (const term of queryTokens) {
      const termStats = index._termStats.get(term);
      if (!termStats) continue; // 词不在索引中

      const freq = docStats.frequencies.get(term) ?? 0;
      if (freq === 0) continue;

      const idf = termStats.idf;
      const docLength = docStats.length;
      const avgDocLength = index._avgDocLength;

      // BM25 公式
      const numerator = freq * (k1 + 1);
      const denominator =
        freq + k1 * (1 - b + b * (docLength / Math.max(avgDocLength, 1)));
      score += idf * (numerator / denominator);
    }

    if (score > 0) {
      scores.set(docId, score);
    }
  }

  // 排序并返回
  const results = Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  return limit > 0 ? results.slice(0, limit) : results;
}
