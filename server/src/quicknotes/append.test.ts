import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { EmptyQuickNote, appendQuickNote, readQuickNotes } from "./append.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "zhandao-notes-"));
  process.env.ZHANDAO_DATA_DIR = dir;
});

test("追加一条速记并读回", async () => {
  const note = await appendQuickNote("依赖里放对象必炸");
  assert.equal(note.text, "依赖里放对象必炸");
  assert.match(note.id, /^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  assert.match(note.at, /^\d{4}-\d{2}-\d{2}T/);

  const all = await readQuickNotes();
  assert.deepEqual(all.map((n) => n.text), ["依赖里放对象必炸"]);
});

test("多条按追加顺序保留", async () => {
  await appendQuickNote("第一条");
  await appendQuickNote("第二条");
  await appendQuickNote("第三条");
  const all = await readQuickNotes();
  assert.deepEqual(all.map((n) => n.text), ["第一条", "第二条", "第三条"]);
});

test("首尾空白被裁掉", async () => {
  const note = await appendQuickNote("  前后都有空格  ");
  assert.equal(note.text, "前后都有空格");
});

test("空内容或纯空白抛 EmptyQuickNote", async () => {
  await assert.rejects(() => appendQuickNote(""), EmptyQuickNote);
  await assert.rejects(() => appendQuickNote("   \n\t "), EmptyQuickNote);
});

test("文件不存在时 readQuickNotes 返回空数组而不抛错", async () => {
  assert.deepEqual(await readQuickNotes(), []);
});

test("坏行被跳过，不让整个文件不可读", async () => {
  await appendQuickNote("好的一条");
  const path = resolve(dir, "quicknotes.jsonl");
  await writeFile(path, (await readFile(path, "utf8")) + "这不是 JSON\n\n", "utf8");
  await appendQuickNote("后面这条也要能读到");

  const all = await readQuickNotes();
  assert.deepEqual(all.map((n) => n.text), ["好的一条", "后面这条也要能读到"]);
});

test("内容里的换行和引号不会破坏 JSONL 的一行一条", async () => {
  await appendQuickNote('他说 "这里\n有换行" 还有反斜杠 \\');
  const raw = await readFile(resolve(dir, "quicknotes.jsonl"), "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 1, "一条速记必须只占一行");

  const all = await readQuickNotes();
  assert.equal(all[0]?.text, '他说 "这里\n有换行" 还有反斜杠 \\');
});

test("速记不携带宿主材料字段——ADR-0009：当场不要求指定宿主", async () => {
  const note = await appendQuickNote("随便一句");
  assert.deepEqual(Object.keys(note).sort(), ["at", "id", "text"]);
});
