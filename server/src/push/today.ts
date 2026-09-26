/**
 * 「今天该读哪篇」——这是一个**事实**，不是一次重算。
 *
 * bug 背景（2026-09-26 逼出来的教训，详见 `CLAUDE.md`「推送链路的实现约束」）：
 * `pickForPush` 引入轮转之后读 `pushes.jsonl` 来排序，而它自己的执行又会往那个
 * 日志里写。于是 hook 早上推了一篇、记进日志，之后网页再问同一个函数，看到那篇
 * 刚推过、排到队尾，给出了下一篇——hook 与网页说法不一致。
 * 根因是**给一个查询函数引入了历史依赖，却让所有调用方仍然当它是幂等的**。
 * `resolveTodaysPush` 把「今天该读哪篇」单独立成一个函数：先看今天是否已经有
 * 定论（`readTodaysPush`），有就直接返回那一篇，只有没有定论时才交给
 * `pickForPush` 去计算下一篇——计算的结果只在没有定论的那一次会被记下来，
 * 从而把「幂等的事实」和「有历史依赖的排序」这两种语义分开，不再共用一个函数。
 */

import { buildMaterialsIndex, getMaterial } from "../search/materials-index.js";
import { computePool, pickForPush, type PoolKind, type PushCandidate } from "./pool.js";
import { readTodaysPush } from "./log.js";

function isPoolKind(v: string | undefined): v is PoolKind {
  return v === "孤岛" || v === "留档";
}

/**
 * 「今天该读哪篇」——三个入口（hook / `GET /api/push/today` / `npm run push`）
 * 都必须调这一个函数，才能保证给出同一个答案。
 */
export async function resolveTodaysPush(now: Date = new Date()): Promise<PushCandidate | null> {
  const record = await readTodaysPush(now);

  // 退路 1：今天还没有定论——这是唯一「计算」的分支，其余都是「查」。
  if (!record) {
    return pickForPush(now);
  }

  const index = await buildMaterialsIndex();
  const material = getMaterial(index, record.materialId);

  // 退路 2：今天推过的那篇材料现在查不到了（推送之后被划掉、文件已删）。
  // 「今天该读」这个事实的载体没了，「不变」也无从谈起，只能退回重算，
  // 让 pickForPush 给出当前真正该推的那一篇。
  if (!material) {
    return pickForPush(now);
  }

  // 用当前的推送池核实这篇材料现在的 kind/since：池子里的数据是「现在」的状态
  // （比如推送之后本人又把它从孤岛标成了留档），比推送记录当时快照的 kind 更准确。
  const pool = await computePool();
  const poolCandidate = pool.find((c) => c.material.id === material.id);

  // kind 优先用记录里的 kind（新写的记录必然带这个字段）；
  // 记录里没有（历史行）就退到池子里查它现在的 kind。
  // 池子里的**当前** kind 优先，日志里记的那个只是兜底（历史行没有 kind 字段）。
  // 顺序不能反过来：标签说的是这篇材料**现在**是什么状态，不是推送那一刻的快照。
  // 反过来写会出现「今天推给你时是孤岛，你当场点了留档，界面还显示孤岛」。
  // 与下面 `since` 的优先级保持一致——两者都该尽量准。
  const kind: PoolKind | undefined =
    poolCandidate?.kind ?? (isPoolKind(record.kind) ? record.kind : undefined);

  // 退路 3：记录里没有 kind、池子里也查不到——说明推送之后本人已经写了标注，
  // 材料已消化、离开了池子。这时「今天该读」已经名不副实（材料不再是待消化的
  // 孤岛或留档，而是已标注的东西），与「材料被划掉」同理，退回重算。
  // 不为此新增第三种 PoolKind，那会波及 computePool 与前端。
  if (!kind) {
    return pickForPush(now);
  }

  // since 优先取池子里现算的那个（孤岛用 captured、留档用最早留档时间，两者都比
  // 推送记录准确）；池子里查不到时（对应上面 kind 走了「记录值」分支的情况）
  // 才退回用记录的 at——不是精确的 since，但足够呈现，且不至于抛错或返回 undefined。
  const since = poolCandidate?.since ?? record.at;

  return { material, kind, since };
}
