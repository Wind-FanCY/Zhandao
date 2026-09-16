import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rmdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMaterialsIndex,
  searchMaterials,
  type IndexedMaterial,
} from "./materials-index.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("materials-index", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-search-test-"));
    process.env.ZHANDAO_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("从临时目录读取并建索引", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    // 写入一个测试文件
    const mdContent = `---
id: test-001
title: Promise Tutorial
source: https://example.com/promise
captured: 2026-09-16T10:00:00Z
---

This is a promise tutorial.`;

    await writeFile(resolve(materialsDir, "test-001-promise.md"), mdContent);

    // 建索引
    const index = await buildMaterialsIndex();

    // 应该能找到这个文件
    assert.equal(index._materials.size, 1);
    const material = index._materials.get("test-001");
    assert.ok(material);
    if (material) {
      assert.equal(material.title, "Promise Tutorial");
      assert.equal(material.source, "https://example.com/promise");
    }
  });

  test("检索到已索引的材料", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    const mdContent = `---
id: test-002
title: Promise
source: https://example.com/promise
captured: 2026-09-16T10:00:00Z
---

Promise is a JavaScript feature.`;

    await writeFile(resolve(materialsDir, "test-002-promise.md"), mdContent);

    const index = await buildMaterialsIndex();
    const results = searchMaterials(index, "Promise");

    assert.ok(results.length > 0);
    assert.equal(results[0].id, "test-002");
  });

  test("标题命中：只在标题里出现的词也能检索到", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    const mdContent = `---
id: test-003
title: ReactJS Guide
source: https://example.com/react
captured: 2026-09-16T10:00:00Z
---

This tutorial covers the framework.`;

    await writeFile(resolve(materialsDir, "test-003-react.md"), mdContent);

    const index = await buildMaterialsIndex();
    const results = searchMaterials(index, "ReactJS");

    assert.ok(results.length > 0);
    assert.equal(results[0].id, "test-003");
  });

  test("frontmatter 坏掉的文件被跳过，其余仍可索引", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    // 好文件
    const goodContent = `---
id: test-004
title: Good Article
source: https://example.com/good
captured: 2026-09-16T10:00:00Z
---

Good content here.`;

    // 坏文件（YAML 无效）
    const badContent = `---
id: test-005
title: Bad Article: {invalid yaml
source: https://example.com/bad
---

Bad content.`;

    await writeFile(resolve(materialsDir, "test-004-good.md"), goodContent);
    await writeFile(resolve(materialsDir, "test-005-bad.md"), badContent);

    const index = await buildMaterialsIndex();

    // 应该只有好文件被索引
    assert.equal(index._materials.size, 1);
    assert.ok(index._materials.has("test-004"));
    assert.ok(!index._materials.has("test-005"));
  });

  test("materials 目录不存在时返回空索引，不抛错", async () => {
    // 不创建 materials 目录
    const index = await buildMaterialsIndex();

    assert.equal(index._materials.size, 0);
    const results = searchMaterials(index, "anything");
    assert.deepEqual(results, []);
  });

  test("materials 目录为空时返回空索引", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    // 不创建任何文件
    const index = await buildMaterialsIndex();

    assert.equal(index._materials.size, 0);
  });

  test("只索引 .md 文件，忽略其他类型", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    const mdContent = `---
id: test-006
title: MD File
source: https://example.com/md
captured: 2026-09-16T10:00:00Z
---

MD content.`;

    await writeFile(resolve(materialsDir, "test-006-md.md"), mdContent);
    await writeFile(resolve(materialsDir, "test-007-txt.txt"), "text content");

    const index = await buildMaterialsIndex();

    assert.equal(index._materials.size, 1);
    assert.ok(index._materials.has("test-006"));
  });

  test("多文件索引和排序", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    const files = [
      {
        name: "test-101-promise.md",
        content: `---
id: test-101
title: Promise Basics
source: https://example.com/promise
captured: 2026-09-16T10:00:00Z
---

Promise is async. Promise is useful.`,
      },
      {
        name: "test-102-async.md",
        content: `---
id: test-102
title: Async Await
source: https://example.com/async
captured: 2026-09-16T10:00:00Z
---

Async await is modern.`,
      },
      {
        name: "test-103-callback.md",
        content: `---
id: test-103
title: Callbacks
source: https://example.com/callback
captured: 2026-09-16T10:00:00Z
---

Callback is old pattern.`,
      },
    ];

    for (const file of files) {
      await writeFile(resolve(materialsDir, file.name), file.content);
    }

    const index = await buildMaterialsIndex();
    assert.equal(index._materials.size, 3);

    // 查询 "Promise"，test-101 应该排第一
    const results = searchMaterials(index, "Promise");
    assert.ok(results.length > 0);
    assert.equal(results[0].id, "test-101");
  });

  test("缺少必需 frontmatter 字段的文件被跳过", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    // 缺少 id
    const missingIdContent = `---
title: No ID Article
source: https://example.com/noid
captured: 2026-09-16T10:00:00Z
---

Content.`;

    // 缺少 title
    const missingTitleContent = `---
id: test-104
source: https://example.com/notitle
captured: 2026-09-16T10:00:00Z
---

Content.`;

    await writeFile(
      resolve(materialsDir, "test-noid.md"),
      missingIdContent,
    );
    await writeFile(
      resolve(materialsDir, "test-notitle.md"),
      missingTitleContent,
    );

    const index = await buildMaterialsIndex();

    // 两个文件都应该被跳过
    assert.equal(index._materials.size, 0);
  });

  test("frontmatter 后无标题符的文件被跳过", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    // 缺少结束的 ---
    const missingEndContent = `---
id: test-105
title: Missing End
source: https://example.com/noend
captured: 2026-09-16T10:00:00Z

Content without ending ---.`;

    await writeFile(
      resolve(materialsDir, "test-missing-end.md"),
      missingEndContent,
    );

    const index = await buildMaterialsIndex();

    // 文件应该被跳过
    assert.equal(index._materials.size, 0);
  });

  test("検索结果包含分数", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    const mdContent = `---
id: test-106
title: Article
source: https://example.com/article
captured: 2026-09-16T10:00:00Z
---

Promise promise promise.`;

    await writeFile(resolve(materialsDir, "test-106.md"), mdContent);

    const index = await buildMaterialsIndex();
    const results = searchMaterials(index, "Promise");

    assert.ok(results.length > 0);
    const result = results[0];
    assert.ok(typeof result.score === "number");
    assert.ok(result.score > 0);
    assert.equal(result.id, "test-106");
    assert.equal(result.title, "Article");
    assert.equal(result.source, "https://example.com/article");
  });

  test("limit 参数在材料索引中生效", async () => {
    const materialsDir = resolve(testDataDir, "materials");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(materialsDir, { recursive: true }),
    );

    for (let i = 1; i <= 5; i++) {
      const content = `---
id: test-${i}
title: Article ${i}
source: https://example.com/article${i}
captured: 2026-09-16T10:00:00Z
---

Promise promise promise.`;

      await writeFile(
        resolve(materialsDir, `test-${i}.md`),
        content,
      );
    }

    const index = await buildMaterialsIndex();
    const results = searchMaterials(index, "Promise", 2);

    assert.equal(results.length, 2);
  });
});
