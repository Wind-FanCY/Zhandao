import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rmdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { load as yamlLoad } from "js-yaml";
import { writeMaterial, type NewMaterial } from "./write.js";

// 模拟 resolveDataDir，让它返回测试用的临时目录
let testDataDir: string;

// 在测试期间，保存原始的 process.env 和 resolveDataDir
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

/**
 * 读回 frontmatter 并收窄成可索引的对象。
 *
 * 用类型守卫而不是 `as Record<string, unknown>`：`yamlLoad` 返回 unknown，
 * 断言只是告诉编译器「相信我」，运行时什么都没检查。测试里断言错了顶多
 * 报个怪错误，但这个仓库今天已经因为同一类写法修过三次 bug，不给它留样板。
 * 见 CLAUDE.md「外部数据必须校验，不能用断言」。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const endIdx = lines.findIndex((line, i) => i > 0 && line === "---");
  assert.ok(endIdx > 0, "Missing closing ---");
  const parsed: unknown = yamlLoad(lines.slice(1, endIdx).join("\n"));
  if (!isRecord(parsed)) throw new Error("frontmatter 解析结果不是对象");
  return parsed;
}

describe("writeMaterial", () => {
  beforeEach(async () => {
    // 创建临时目录
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-test-"));
    // 设置环境变量指向临时目录
    process.env.ZHANDAO_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    // 清理临时目录
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
    // 恢复环境变量
    if (originalDataDirEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("should write material and return id and path", async () => {
    const material: NewMaterial = {
      title: "Test Article",
      markdown: "# Heading\n\nSome content here.",
      source: "https://example.com/article",
    };

    const result = await writeMaterial(material);

    assert.ok(result.id);
    assert.match(result.id, /^[A-Z0-9]{26}$/);
    assert.match(result.path, /\/materials\/[A-Z0-9]{26}-Test-Article\.md$/);
  });

  test("should create materials directory if not exists", async () => {
    const material: NewMaterial = {
      title: "Test",
      markdown: "Content",
      source: "https://example.com",
    };

    await writeMaterial(material);

    const materialsPath = resolve(testDataDir, "materials");
    const stat = await import("node:fs/promises").then((fs) =>
      fs.stat(materialsPath),
    );
    assert.ok(stat.isDirectory());
  });

  test("should include correct frontmatter", async () => {
    const material: NewMaterial = {
      title: "Test Article",
      markdown: "# Content",
      source: "https://example.com/test",
    };

    const result = await writeMaterial(material);

    const content = await readFile(result.path, "utf-8");
    const lines = content.split("\n");

    // 检查 frontmatter 分隔符
    assert.equal(lines[0], "---");

    const frontmatter = parseFrontmatter(content);

    assert.equal(frontmatter.title, "Test Article");
    assert.equal(frontmatter.source, "https://example.com/test");
    assert.ok(frontmatter.id);
    assert.ok(frontmatter.captured);

    // 验证 captured 是 ISO 8601 格式
    const captured = new Date(frontmatter.captured as string);
    assert.ok(!isNaN(captured.getTime()));
  });

  test("should preserve markdown content exactly", async () => {
    const originalMarkdown = "# Title\n\nParagraph 1\n\nParagraph 2\n\n```javascript\ncode block\n```";

    const material: NewMaterial = {
      title: "Test",
      markdown: originalMarkdown,
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    const content = await readFile(result.path, "utf-8");

    // 提取正文（frontmatter 后面的内容）
    const lines = content.split("\n");
    const endIdx = lines.findIndex((line, i) => i > 0 && line === "---");
    const markdown = lines.slice(endIdx + 2).join("\n"); // +2 跳过 --- 和空行

    assert.equal(markdown, originalMarkdown);
  });

  test("should sanitize title with slashes and backslashes", async () => {
    const material: NewMaterial = {
      title: "Test / With \\ Slashes",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 应该去掉 / 和 \
    assert.match(result.path, /Test-With-Slashes/);
  });

  test("should sanitize title with colons and quotes", async () => {
    const material: NewMaterial = {
      title: 'Test: With "Quotes"',
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 应该去掉 : 和 "
    assert.match(result.path, /Test-With-Quotes/);
  });

  test("should preserve Chinese characters in title", async () => {
    const material: NewMaterial = {
      title: "中文标题测试",
      markdown: "内容",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 应该保留中文字符
    assert.match(result.path, /中文标题测试/);
  });

  test("should collapse whitespace to single dash", async () => {
    const material: NewMaterial = {
      title: "Test   With   Many    Spaces",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 多个空白应该折叠成单个 -
    assert.match(result.path, /Test-With-Many-Spaces/);
  });

  test("should truncate long titles", async () => {
    const material: NewMaterial = {
      title: "This is a very long title that should be truncated because it exceeds the maximum character limit of sixty characters",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 提取文件名中的标题部分
    const filename = result.path.split("/").pop()!;
    const titlePart = filename.split("-").slice(1).join("-").replace(".md", "");

    assert.ok(titlePart.length <= 60);
  });

  test("should use only ulid when title becomes empty after sanitization", async () => {
    const material: NewMaterial = {
      title: "///\\\\:::***",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // 应该只有 ulid，没有额外的标题部分
    assert.match(result.path, /\/materials\/[A-Z0-9]{26}\.md$/);
  });

  test("should handle title with hash character", async () => {
    const material: NewMaterial = {
      title: "Test # With # Hashes",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    // # 应该被保留或去掉（取决于是否在清理字符列表中）
    // 根据实现，# 不在清理列表中，应该保留
    const content = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(content);

    // YAML 应该能正确解析包含 # 的标题
    assert.equal(frontmatter.title, "Test # With # Hashes");
  });

  test("should correctly parse frontmatter with colon in title", async () => {
    const material: NewMaterial = {
      title: "Vue.js: The Progressive Framework",
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    const content = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(content);

    assert.equal(frontmatter.title, "Vue.js: The Progressive Framework");
  });

  test("should correctly parse frontmatter with quotes in title", async () => {
    const material: NewMaterial = {
      title: 'Quote: "This is a test"',
      markdown: "Content",
      source: "https://example.com",
    };

    const result = await writeMaterial(material);
    const content = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(content);

    assert.equal(frontmatter.title, 'Quote: "This is a test"');
  });

  test("should be idempotent for reading back written material", async () => {
    const material: NewMaterial = {
      title: "Idempotent Test",
      markdown: "# Test Content\n\nWith multiple lines\nAnd paragraphs",
      source: "https://example.com/test",
    };

    const result = await writeMaterial(material);
    const content = await readFile(result.path, "utf-8");

    // 第二次读取应该得到相同的内容
    const content2 = await readFile(result.path, "utf-8");
    assert.equal(content, content2);
  });
});

describe("from 字段（ADR-0010：索引页展开出的材料）", () => {
  test("有 from 时，frontmatter 里出现且在最后一行", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "zhandao-from-"));
    process.env.ZHANDAO_DATA_DIR = dir;

    const result = await writeMaterial({
      title: "TCP 不 listen 会怎样",
      markdown: "# 正文\n\n内容",
      source: "https://xiaolincoding.com/network/3_tcp/tcp_no_listen.html",
      from: "https://xiaolincoding.com/network/",
    });

    const raw = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(raw);

    assert.equal(frontmatter.from, "https://xiaolincoding.com/network/");

    // from 必须是 frontmatter 的最后一个键
    const keys = Object.keys(frontmatter);
    assert.equal(keys[keys.length - 1], "from", `from 应在最后，实际顺序: ${keys.join(",")}`);
  });

  test("无 from 时，frontmatter 完全不出现该键", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "zhandao-nofrom-"));
    process.env.ZHANDAO_DATA_DIR = dir;

    const result = await writeMaterial({
      title: "普通材料",
      markdown: "内容",
      source: "https://example.com/a",
    });

    const raw = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(raw);

    assert.equal(Object.prototype.hasOwnProperty.call(frontmatter, "from"), false);
    assert.ok(!raw.includes("from:"), `frontmatter 不应包含 from 键:\n${raw}`);
  });

  test("from 含中文与查询串时，往返解析正确", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "zhandao-from-cjk-"));
    process.env.ZHANDAO_DATA_DIR = dir;

    const fromUrl = "https://example.com/索引页?ref=weekly&utm_source=测试#top";
    const result = await writeMaterial({
      title: "带查询串来源的材料",
      markdown: "内容",
      source: "https://example.com/a.html",
      from: fromUrl,
    });

    const raw = await readFile(result.path, "utf-8");
    const frontmatter = parseFrontmatter(raw);

    assert.equal(frontmatter.from, fromUrl);
  });
});

test("frontmatter 的 title 必须在一行内，且可被 grep 命中", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "zhandao-grep-"));
  process.env.ZHANDAO_DATA_DIR = dir;

  const title = "45 道 Promise 面试题：手写实现与执行顺序";
  const { path } = await writeMaterial({
    title,
    markdown: "# 正文\n\n内容",
    source: "https://example.com/a",
  });

  const raw = await readFile(path, "utf8");

  // lineWidth: 0 会把标题按空格拆成多行，grep 就找不到了（ADR-0003 要求可 grep）
  assert.ok(
    raw.includes(`title: ${title}`) || raw.includes(`title: "${title}"`) || raw.includes(`title: '${title}'`),
    `标题应完整出现在一行内，实际 frontmatter:\n${raw.split("---")[1]}`,
  );

  // 逐行检查：必须有某一行同时包含标题的首尾片段
  const line = raw.split("\n").find((l) => l.startsWith("title:"));
  assert.ok(line?.includes("45 道 Promise") && line?.includes("执行顺序"), `title 行被截断: ${line}`);
});
