import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { resolve } from "node:path";
import { resolveDataDir } from "./data-dir.js";

describe("resolveDataDir", () => {
  const originalEnv = process.env.ZHANDAO_DATA_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.ZHANDAO_DATA_DIR;
  });

  afterEach(() => {
    // 恢复环境变量
    if (originalEnv !== undefined) {
      process.env.ZHANDAO_DATA_DIR = originalEnv;
    } else {
      delete process.env.ZHANDAO_DATA_DIR;
    }
  });

  test("should resolve from absolute path in env var", () => {
    process.env.ZHANDAO_DATA_DIR = "/custom/data/path";
    const result = resolveDataDir();
    assert.equal(result, "/custom/data/path");
  });

  test("should resolve from relative path in env var", () => {
    process.env.ZHANDAO_DATA_DIR = "custom/data/path";
    const result = resolveDataDir();
    const expected = resolve(process.cwd(), "custom/data/path");
    assert.equal(result, expected);
  });

  test("should resolve default path when env var not set", () => {
    delete process.env.ZHANDAO_DATA_DIR;
    const result = resolveDataDir();
    // 默认路径应该包含 data 目录
    assert.match(result, /\/data$/);
    // 且应该是兄弟目录（../data 相对于 server/src）
    assert.match(result, /Zhandao[/\\]data$/);
  });
});
