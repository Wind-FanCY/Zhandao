import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { load as yamlLoad } from "js-yaml";
import {
  writeAnnotation,
  EmptyAnnotation,
  MissingHostMaterial,
  type NewAnnotation,
} from "./write.js";

/** 类型守卫而非 `as` 断言：测试里读回 YAML/JSON 解析结果时收窄类型 */
function assertIsRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected an object");
}

let testDataDir: string;
const originalDataDirEnv = process.env.ZHANDAO_DATA_DIR;

describe("writeAnnotation", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(resolve(tmpdir(), "zhandao-annotation-test-"));
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

  test("写入标注并返回 id 与 path", async () => {
    const a: NewAnnotation = { materialId: "01MATERIALID", text: "依赖里放对象必炸" };
    const result = await writeAnnotation(a);

    assert.ok(result.id);
    assert.match(result.id, /^[A-Z0-9]{26}$/);
    assert.match(result.path, /\/annotations\/[A-Z0-9]{26}-依赖里放对象必炸\.md$/);
  });

  test("创建 annotations 目录（如不存在）", async () => {
    await writeAnnotation({ materialId: "m1", text: "内容" });
    const dir = resolve(testDataDir, "annotations");
    const stat = await import("node:fs/promises").then((fs) => fs.stat(dir));
    assert.ok(stat.isDirectory());
  });

  test("frontmatter 恰好四个字段，顺序为 id / material / targets / at", async () => {
    const result = await writeAnnotation({ materialId: "01MATERIALID", text: "一些理解" });
    const content = await readFile(result.path, "utf-8");
    const lines = content.split("\n");

    assert.equal(lines[0], "---");
    const endIdx = lines.findIndex((line, i) => i > 0 && line === "---");
    const frontmatterStr = lines.slice(1, endIdx).join("\n");
    const frontmatter: unknown = yamlLoad(frontmatterStr);
    assertIsRecord(frontmatter);

    assert.deepEqual(Object.keys(frontmatter), ["id", "material", "targets", "at"]);
    assert.equal(frontmatter.id, result.id);
    assert.equal(frontmatter.material, "01MATERIALID");
    assert.deepEqual(frontmatter.targets, []);
    if (typeof frontmatter.at !== "string") {
      throw new Error("at 应为 string");
    }
    assert.ok(!isNaN(new Date(frontmatter.at).getTime()));
  });

  test("正文为 trim 后的 text", async () => {
    const result = await writeAnnotation({ materialId: "m1", text: "  前后有空格的理解  " });
    const content = await readFile(result.path, "utf-8");
    const lines = content.split("\n");
    const endIdx = lines.findIndex((line, i) => i > 0 && line === "---");
    const body = lines.slice(endIdx + 2).join("\n");
    assert.equal(body, "前后有空格的理解");
  });

  test("text trim 后为空抛 EmptyAnnotation", async () => {
    await assert.rejects(() => writeAnnotation({ materialId: "m1", text: "" }), EmptyAnnotation);
    await assert.rejects(
      () => writeAnnotation({ materialId: "m1", text: "   \n\t " }),
      EmptyAnnotation,
    );
  });

  test("materialId trim 后为空抛 MissingHostMaterial", async () => {
    await assert.rejects(
      () => writeAnnotation({ materialId: "", text: "内容" }),
      MissingHostMaterial,
    );
    await assert.rejects(
      () => writeAnnotation({ materialId: "   ", text: "内容" }),
      MissingHostMaterial,
    );
  });

  test("摘要为空（清理后无合法字符）时只用 ulid 作文件名", async () => {
    const result = await writeAnnotation({ materialId: "m1", text: "///\\\\:::***" });
    assert.match(result.path, /\/annotations\/[A-Z0-9]{26}\.md$/);
  });

  test("摘要截断到 24 个字符", async () => {
    const longText = "这是一条非常非常非常非常非常非常非常非常长的速记内容用来测试摘要截断";
    const result = await writeAnnotation({ materialId: "m1", text: longText });
    const filename = result.path.split("/").pop()!;
    const summaryPart = filename.slice(27, -3); // 去掉 ulid- 前缀与 .md 后缀
    assert.ok(summaryPart.length <= 24);
  });

  test("lineWidth 为 -1：frontmatter 各字段都在单行内、可被 grep 命中", async () => {
    const result = await writeAnnotation({ materialId: "01MATERIALID", text: "一句话标注" });
    const raw = await readFile(result.path, "utf-8");
    const line = raw.split("\n").find((l) => l.startsWith("material:"));
    assert.ok(line?.includes("01MATERIALID"));
  });
});
