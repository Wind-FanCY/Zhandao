import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { cacheExtraction, readCachedExtraction } from "./extract-cache.js";

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("extract-cache.ts", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-cache-test-"));
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

  test("readCachedExtraction should return null when cache doesn't exist", async () => {
    const result = await readCachedExtraction("https://example.com/test");
    assert.strictEqual(result, null);
  });

  test("cacheExtraction should create cache file", async () => {
    const url = "https://example.com/article";
    const markdown = "# Test Article\n\nContent here";

    await cacheExtraction(url, markdown);

    const cacheDir = resolve(testDataDir, ".cache");
    const files = await readdir(cacheDir);
    assert.strictEqual(files.length, 1);
  });

  test("cacheExtraction and readCachedExtraction should roundtrip", async () => {
    const url = "https://example.com/article";
    const markdown = "# Test Article\n\nWith multiple lines\nAnd paragraphs";

    await cacheExtraction(url, markdown);
    const result = await readCachedExtraction(url);

    assert.strictEqual(result, markdown);
  });

  test("should use stable cache filename for same URL", async () => {
    const url = "https://example.com/article";
    const markdown1 = "First content";
    const markdown2 = "Updated content";

    // 第一次缓存
    await cacheExtraction(url, markdown1);
    const cacheDir1 = resolve(testDataDir, ".cache");
    const files1 = await readdir(cacheDir1);

    // 第二次缓存（同一 URL）
    await cacheExtraction(url, markdown2);
    const files2 = await readdir(cacheDir1);

    // 应该还是只有一个文件（覆盖）
    assert.strictEqual(files1.length, 1);
    assert.strictEqual(files2.length, 1);
    assert.strictEqual(files1[0], files2[0]);

    // 内容应该是更新后的
    const result = await readCachedExtraction(url);
    assert.strictEqual(result, markdown2);
  });

  test("different URLs should have different cache files", async () => {
    const url1 = "https://example.com/article1";
    const url2 = "https://example.com/article2";
    const markdown = "# Content";

    await cacheExtraction(url1, markdown);
    await cacheExtraction(url2, markdown);

    const cacheDir = resolve(testDataDir, ".cache");
    const files = await readdir(cacheDir);

    assert.strictEqual(files.length, 2);
    assert.notStrictEqual(files[0], files[1]);
  });

  test("should preserve markdown content exactly", async () => {
    const url = "https://example.com/test";
    const markdown = `# Complex Markdown

## Code blocks
\`\`\`javascript
function test() {
  console.log("hello");
}
\`\`\`

## Lists
- Item 1
- Item 2
  - Nested

## Links
[Link](https://example.com)

特殊字符：中文，引号"，冒号：，反斜杠\\`;

    await cacheExtraction(url, markdown);
    const result = await readCachedExtraction(url);

    assert.strictEqual(result, markdown);
  });

  test("cache directory should be created automatically", async () => {
    const url = "https://example.com/test";
    const markdown = "Test content";

    // 缓存目录不应该提前存在
    const cacheDirBefore = resolve(testDataDir, ".cache");
    try {
      await readdir(cacheDirBefore);
      assert.fail("Cache directory should not exist before first write");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // 缓存后应该存在
    await cacheExtraction(url, markdown);
    const files = await readdir(cacheDirBefore);

    assert.strictEqual(files.length, 1);
  });

  test("URL with query parameters should have stable cache filename", async () => {
    const url1 = "https://example.com/article?param=value";
    const url2 = "https://example.com/article?param=value"; // Same URL
    const markdown = "Content";

    await cacheExtraction(url1, markdown);
    const cacheDir = resolve(testDataDir, ".cache");
    const files1 = await readdir(cacheDir);

    await cacheExtraction(url2, markdown);
    const files2 = await readdir(cacheDir);

    assert.strictEqual(files1.length, 1);
    assert.strictEqual(files2.length, 1);
    assert.strictEqual(files1[0], files2[0]);
  });

  test("long URLs should work correctly", async () => {
    const longUrl =
      "https://example.com/very/long/path/to/article?param1=value1&param2=value2&param3=value3&param4=value4";
    const markdown = "Content";

    await cacheExtraction(longUrl, markdown);
    const result = await readCachedExtraction(longUrl);

    assert.strictEqual(result, markdown);
  });

  test("URL fragments should not affect cache filename", async () => {
    // 注意：fetch 会自动去掉 fragment，所以这里测试的是同一个 URL
    const url = "https://example.com/article";
    const markdown = "Content";

    await cacheExtraction(url, markdown);
    const result = await readCachedExtraction(url);

    assert.strictEqual(result, markdown);
  });

  test("empty markdown should be cacheable", async () => {
    const url = "https://example.com/test";
    const markdown = "";

    await cacheExtraction(url, markdown);
    const result = await readCachedExtraction(url);

    assert.strictEqual(result, "");
  });
});
