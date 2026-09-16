/**
 * 命令行检索工具。
 *
 * 用法：npm run search -- "查询词"
 * 或：npm run search -- --list 列出所有材料
 *
 * 建立索引并执行查询，打印排名结果。
 */

import { buildMaterialsIndex, searchMaterials } from "../search/materials-index.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("用法: npm run search -- \"查询词\"");
    console.log("      npm run search -- --list    列出所有材料");
    process.exit(1);
  }

  // 建索引
  console.log("[搜索] 建立索引...");
  const index = await buildMaterialsIndex();

  // --list 模式
  if (args[0] === "--list") {
    const materials = Array.from(index._materials.values());
    if (materials.length === 0) {
      console.log("[搜索] 没有材料");
    } else {
      console.log(`[搜索] ${materials.length} 篇材料：\n`);
      materials.forEach((m, i) => {
        console.log(`${i + 1}. ${m.title}`);
        console.log(`   来源: ${m.source}`);
        console.log();
      });
    }
    return;
  }

  // 查询模式
  const query = args.join(" ");
  console.log(`[搜索] 查询: "${query}"\n`);

  const results = searchMaterials(index, query);

  if (results.length === 0) {
    console.log("没有结果");
  } else {
    results.forEach((result, i) => {
      const score = result.score.toFixed(2);
      console.log(`${i + 1}. ${result.title}`);
      console.log(`   分数: ${score}`);
      console.log(`   来源: ${result.source}`);
      console.log();
    });
  }
}

main().catch((err) => {
  console.error("[搜索] 错误:", err);
  process.exit(1);
});
