/**
 * 推送池：算出「今天该推哪一篇材料去读」。
 *
 * 冷启动期推的是一篇未消化的**材料**（读），不是**题目**（考）——出题需要至少一条
 * **标注**，而库里标注个位数，出题从冷启动就无从下手（CLAUDE.md「推送链路的实现约束」）。
 *
 * 推送池顺序：**孤岛**优先，其次**留档**时间最早。这是排序，不是到期日——
 * 没有东西会「到期」，只是前面的池子空了之后，下一项自然成为候选（ADR-0004：
 * 依据本人自己的行为，不引入通用间隔常数）。
 */

import { buildMaterialsIndex, listMaterials, type IndexedMaterial } from "../search/materials-index.js";
import { readAnnotations } from "../annotations/read.js";
import { readArchivedIds } from "../materials/archive.js";
import { readLastPushTimes } from "./log.js";

export type PoolKind = "孤岛" | "留档";

export interface PushCandidate {
  material: IndexedMaterial;
  kind: PoolKind;
  /** 孤岛用 captured（收录时刻），留档用最早那次留档时间 */
  since: string;
}

/**
 * 计算当前推送池，孤岛在前（按 since 升序），留档在后（按 since 升序）。
 *
 * 「已消化」集合 = 出现在任意一条**标注**的 `material`（归属宿主）字段，
 * 或任意一条**标注**的 `targets`（关联）数组里的材料 id——两处都算「已消化」。
 * **练题记录**刻意**不是**第三个来源：**预练**不产出**标注**，让它清空**孤岛**等于开出
 * 第二个「什么都不写」的排水口，而第一个（**留档**）已被记为必然被滥用（ADR-0011）。
 *
 * 孤岛 = 不在已消化集合、也不在留档集合里的材料；
 * 留档池 = 在留档集合里、且仍不在已消化集合里的材料
 * （「留档不是永久的」——CONTEXT.md：留档过的材料会在孤岛清空后重新进池，
 * 除非它后来又被写了标注，那时它已消化，不再出现在任何池子里）。
 */
export async function computePool(): Promise<PushCandidate[]> {
  const [index, annotations, archivedIds] = await Promise.all([
    buildMaterialsIndex(),
    readAnnotations(),
    readArchivedIds(),
  ]);
  const materials = listMaterials(index);

  const digested = new Set<string>();
  for (const a of annotations) {
    digested.add(a.material);
    for (const target of a.targets) digested.add(target);
  }

  const islands: PushCandidate[] = [];
  const archived: PushCandidate[] = [];

  for (const material of materials) {
    if (digested.has(material.id)) continue;

    const archivedAt = archivedIds.get(material.id);
    if (archivedAt !== undefined) {
      archived.push({ material, kind: "留档", since: archivedAt });
    } else {
      // captured 可能缺失（手改材料时误删）。缺失时排到队尾而不是队首：
      // 我们不知道它多老，不该让一个畸形的 frontmatter 插队。
      islands.push({ material, kind: "孤岛", since: material.captured ?? "9999" });
    }
  }

  islands.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  archived.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));

  return [...islands, ...archived];
}

/**
 * 在同一层级（孤岛 / 留档）内部，按「上次被推送的时间」升序稳定重排。
 *
 * 从没推过的材料在 `lastPush` 里查不到，视为「最久」——排最前面，
 * 这样冷启动（`pushes.jsonl` 还是空文件）时行为与改动前完全一致：谁都没推过，
 * 退化回原来的 since 顺序（因为 `Array.prototype.sort` 是稳定排序，
 * 平手——包括「两个都查不到」——保留输入顺序，也就是 `computePool` 给定的 since 顺序）。
 *
 * **只在传入的这一组内部重排，不跨组**：调用方按 kind 分组后分别调用，
 * 保证「孤岛优先于留档」这条 ADR-0004 定的优先级不被推送时间覆盖——
 * 如果把上次推送时间当全局主键，一篇刚收录、从没推过的留档材料会插到
 * 刚推过的孤岛前面去，那就是拿排序常数悄悄改写了层级顺序。
 */
function reorderByLastPush(
  candidates: PushCandidate[],
  lastPush: Map<string, string>,
): PushCandidate[] {
  return [...candidates].sort((a, b) => {
    const ta = lastPush.get(a.material.id) ?? "";
    const tb = lastPush.get(b.material.id) ?? "";
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0; // 平手：稳定排序保留原 since 顺序
  });
}

/**
 * 从推送池取出今天该推的那一条。
 *
 * **轮转，不是卡住不动**：改动前直接取池首，池首按 `captured`（孤岛）/ 最早留档时间
 * （留档）排列，于是一篇材料会每天被推同一行，直到本人处理它——实测「手撕代码篇」
 * 连着推了四天同一行。本人原话：「我觉得每天推不一样的篇章说不定我看到想看的就点进去了」
 * ——这正是「认出来比想起来容易」那条：卡住不动的那行只给一次认出的机会。
 *
 * 做法：在孤岛、留档各自内部按「上次被推送的时间」升序重排（`reorderByLastPush`），
 * 再取重排后的池首。**没有引入任何常数**，依然是纯排序——「最久没推过的排前面」
 * 与「留档最早的排前面」是同一种排序手法，不是到期日。也**不需要「一轮」这个概念**：
 * 45 篇材料各推过一次之后，最久没推的那篇自然回到队首，天然循环，不必显式判断
 * 「是否轮完一圈」。
 *
 * 池子里没有合适的（空池）返回 null——「今天没有」是合法输出，不是错误。
 *
 * 如果重排后的池首是**留档**类、且留档时间与 `now` 是同一个自然日，返回 null：
 * 不重推「今天刚处理过」的材料。**这不是间隔算法，是同日去重**——ADR-0004 禁的是
 * 按天数递增的通用间隔（艾宾浩斯 / SM-2 那一类），这里没有任何常数、没有到期日，
 * 只是防止「一路点留档」在同一天里把刚留档的材料立刻又推回来。
 * 孤岛没有这条限制：孤岛的 since 是收录时刻，不是「刚处理过」的信号。
 * 这条去重逻辑本身不变，只是现在作用在重排后的队首上。
 *
 * **本函数仍是纯查询，不写推送日志**——写日志（`appendPush`）是调用方
 * （`scripts/push.ts`）的事：只有「本人这次真的看到了推送」才该记一条，
 * 而这个判断（是否是 `--once-per-day` 放行的那一次）不属于推送池的职责。
 */
export async function pickForPush(now: Date = new Date()): Promise<PushCandidate | null> {
  const pool = await computePool();
  if (pool.length === 0) return null;

  const lastPush = await readLastPushTimes();
  const islands = reorderByLastPush(
    pool.filter((c) => c.kind === "孤岛"),
    lastPush,
  );
  const archived = reorderByLastPush(
    pool.filter((c) => c.kind === "留档"),
    lastPush,
  );

  const first = [...islands, ...archived][0];
  if (!first) return null;

  if (first.kind === "留档" && isSameLocalDay(new Date(first.since), now)) {
    return null;
  }

  return first;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
