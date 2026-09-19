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
 * 从推送池取出今天该推的那一条。
 *
 * 池子里没有合适的（空池）返回 null——「今天没有」是合法输出，不是错误。
 *
 * 如果池首是**留档**类、且留档时间与 `now` 是同一个自然日，返回 null：
 * 不重推「今天刚处理过」的材料。**这不是间隔算法，是同日去重**——ADR-0004 禁的是
 * 按天数递增的通用间隔（艾宾浩斯 / SM-2 那一类），这里没有任何常数、没有到期日，
 * 只是防止「一路点留档」在同一天里把刚留档的材料立刻又推回来。
 * 孤岛没有这条限制：孤岛的 since 是收录时刻，不是「刚处理过」的信号。
 */
export async function pickForPush(now: Date = new Date()): Promise<PushCandidate | null> {
  const pool = await computePool();
  const first = pool[0];
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
