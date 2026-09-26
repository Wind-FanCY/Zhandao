import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildMaterialsIndex, type MaterialsIndex } from "../search/materials-index.js";
import { toolSearch, toolOutline, toolRead, type ToolContext } from "./tools.js";

// 形状照抄 search/materials-index.test.ts / drills/records.test.ts：
// mkdtemp + ZHANDAO_DATA_DIR，绝不碰真实 ../data。

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

async function writeMaterial(filename: string, frontmatter: Record<string, string>, body: string) {
  const materialsDir = resolve(testDataDir, "materials");
  await mkdir(materialsDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await writeFile(resolve(materialsDir, filename), `---\n${fm}\n---\n\n${body}`);
}

describe("qa/tools", () => {
  let index: MaterialsIndex;
  let ctx: ToolContext;

  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-qa-tools-test-"));
    process.env.ZHANDAO_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  describe("toolSearch", () => {
    beforeEach(async () => {
      await writeMaterial(
        "m1.md",
        { id: "m1", title: "Undici 与本地代理", source: "https://example.com/m1" },
        "undici 的 fetch 不读 http_proxy 环境变量，要用 EnvHttpProxyAgent。",
      );
      await writeMaterial(
        "m2.md",
        { id: "m2", title: "Promise 面试题", source: "https://example.com/m2" },
        "Promise.all 和 Promise.race 有什么区别？",
      );
      index = await buildMaterialsIndex();
      ctx = { index };
    });

    test("只返回 materialId / title / from / score，不带 markdown 全文", async () => {
      const hits = toolSearch(ctx, "undici 代理");
      assert.ok(hits.length > 0);
      const [first] = hits;
      assert.ok(first);
      assert.strictEqual(first.materialId, "m1");
      assert.strictEqual(first.title, "Undici 与本地代理");
      assert.strictEqual(typeof first.score, "number");
      // SearchHit 类型上就没有 markdown 字段，这里再从运行时确认一次不会被顺手带出来
      assert.strictEqual(Object.prototype.hasOwnProperty.call(first, "markdown"), false);
    });

    test("默认 limit 是 5", async () => {
      // 库里只有 2 篇材料，不足以直接验证"最多 5 条"，但可以验证不传 limit 时能正常工作
      // 且不会因为"漏传参数报错"——真正的数量上限行为已经在 searchMaterials/bm25 里测过。
      const hits = toolSearch(ctx, "undici");
      assert.ok(hits.length <= 5);
    });

    test("查询命中不到东西时返回空数组", async () => {
      // 用纯拉丁乱码词：BM25 是精确词项匹配，CJK 默认还开着单字模式，随手写的中文短语
      // 十有八九会跟材料正文共享几个常见汉字（比如"不"）产生非零分——不是这里要测的东西。
      // 换成一个不构成任何材料标题/正文里出现过的词的拉丁字符串，才干净地测到"真的没搜到"。
      const hits = toolSearch(ctx, "zzxxccvvbbnnmmqqwweerrttyy");
      assert.deepStrictEqual(hits, []);
    });
  });

  describe("toolOutline", () => {
    beforeEach(async () => {
      await writeMaterial(
        "m1.md",
        { id: "m1", title: "防抖与节流", source: "https://example.com/m1" },
        ["# 防抖与节流", "", "## 什么是防抖函数？", "", "**手写一个防抖函数**", "", "正文不是候选行。"].join("\n"),
      );
      index = await buildMaterialsIndex();
      ctx = { index };
    });

    test("直接复用 collectCandidateLines 的枚举结果", () => {
      const outline = toolOutline(ctx, "m1");
      assert.ok(outline);
      assert.strictEqual(outline?.title, "防抖与节流");
      assert.deepStrictEqual(
        outline?.entries.map((e) => e.line),
        [0, 2, 4],
      );
    });

    test("材料不存在返回 null", () => {
      assert.strictEqual(toolOutline(ctx, "不存在的id"), null);
    });
  });

  describe("toolRead 的代码围栏（真实语料里撞出来的）", () => {
    beforeEach(async () => {
      // 复刻 data/materials 里「4.22 用了 TCP 协议，数据一定不会丢吗？」那篇的形状：
      // 围栏内有 shell 提示符注释，行首是 `# `，会被朴素的标题正则当成一级标题。
      await writeMaterial(
        "fence.md",
        { id: "f1", title: "TCP 队列溢出", source: "https://example.com/f1" },
        [
          "## 全连接队列",                  // line 5
          "",
          "先看怎么观察：",
          "",
          "```bash",
          "# 全连接队列溢出次数",
          "# netstat -s | grep overflowed",
          "```",
          "",
          "上面这条命令的输出如果一直在涨，说明队列满了。",  // 这句必须还在
          "",
          "## 半连接队列",                  // 真正的边界
          "",
          "另一回事。",
        ].join("\n"),
      );
      index = await buildMaterialsIndex();
      ctx = { index };
    });

    test("围栏内的 `#` 注释不构成切片边界，注释之后的正文必须还在", () => {
      const outline = toolOutline(ctx, "f1");
      assert.ok(outline);
      const h = outline.entries.find((e) => e.text.includes("全连接队列") && e.text.startsWith("##"));
      assert.ok(h, "应当能在大纲里找到「## 全连接队列」");

      const got = toolRead(ctx, "f1", h.line);
      assert.ok(got);
      // 这一条就是 bug 的判据：修之前，正文会在 `# 全连接队列溢出次数` 处被砍掉
      assert.ok(
        got.text.includes("上面这条命令的输出如果一直在涨"),
        "围栏后面的解释被切掉了——headingLevel 又把 shell 注释当成标题了",
      );
      // 边界仍然正确：下一个真标题不该被包进来
      assert.ok(!got.text.includes("另一回事"), "切过头了，越过了「## 半连接队列」");
    });
  });

  describe("toolRead", () => {
    beforeEach(async () => {
      // 行号（0-based）：
      // 0: # 标题 A (level1)       5: ## 子标题 A2 (level2)
      // 1: 正文 A                  6: 内容 A2
      // 2: ## 子标题 A1 (level2)   7: # 标题 B (level1)
      // 3: ### 子子标题 A1a(level3) 8: 内容 B
      // 4: 内容 A1a
      await writeMaterial(
        "m1.md",
        { id: "m1", title: "多级标题材料", source: "https://example.com/m1" },
        [
          "# 标题 A",
          "正文 A",
          "## 子标题 A1",
          "### 子子标题 A1a",
          "内容 A1a",
          "## 子标题 A2",
          "内容 A2",
          "# 标题 B",
          "内容 B",
        ].join("\n"),
      );
      index = await buildMaterialsIndex();
      ctx = { index };
    });

    test("从顶级标题开始，切到下一个同级标题为止（跳过更细的子标题）", () => {
      const result = toolRead(ctx, "m1", 0);
      assert.ok(result);
      assert.strictEqual(
        result?.text,
        ["# 标题 A", "正文 A", "## 子标题 A1", "### 子子标题 A1a", "内容 A1a", "## 子标题 A2", "内容 A2"].join("\n"),
      );
    });

    test("从二级标题开始，只被同级或更高级标题挡住，更细的子标题不算边界", () => {
      const result = toolRead(ctx, "m1", 2);
      assert.ok(result);
      assert.strictEqual(
        result?.text,
        ["## 子标题 A1", "### 子子标题 A1a", "内容 A1a"].join("\n"),
      );
    });

    test("起始行不是标题时，切到下一个任意标题为止", () => {
      const result = toolRead(ctx, "m1", 1);
      assert.ok(result);
      assert.strictEqual(result?.text, "正文 A");
    });

    test("最后一节没有下一个标题时，读到文末", () => {
      const result = toolRead(ctx, "m1", 7);
      assert.ok(result);
      assert.strictEqual(result?.text, ["# 标题 B", "内容 B"].join("\n"));
    });

    test("行号越界返回 null", () => {
      assert.strictEqual(toolRead(ctx, "m1", 999), null);
      assert.strictEqual(toolRead(ctx, "m1", -1), null);
    });

    test("材料不存在返回 null", () => {
      assert.strictEqual(toolRead(ctx, "不存在的id", 0), null);
    });

    test("超过 4000 字符时截断并加提示后缀", async () => {
      const longLine = "口".repeat(5000);
      await writeMaterial(
        "m2.md",
        { id: "m2", title: "超长材料", source: "https://example.com/m2" },
        ["# 唯一标题", longLine].join("\n"),
      );
      index = await buildMaterialsIndex();
      ctx = { index };

      const result = toolRead(ctx, "m2", 0);
      assert.ok(result);
      assert.ok(result?.text.endsWith("…（本段已截断）"));
      // 4000 字符原文 + 截断提示后缀，不是"4000 加全部原文"
      assert.strictEqual(result?.text.length, 4000 + "…（本段已截断）".length);
    });
  });
});
