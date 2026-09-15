import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { InboxFolderNotFound, readInbox } from "./chrome-bookmarks.js";

/** Unix epoch 对应的 Chrome 时间戳：自 1601-01-01 起的微秒数。 */
const CHROME_TS_AT_UNIX_EPOCH = "11644473600000000";

let dir: string | undefined;
async function fixture(name: string, data: unknown): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "zhandao-bookmarks-"));
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(data), "utf8");
  return path;
}

const url = (name: string, href: string, date_added?: string) => ({
  type: "url" as const,
  name,
  url: href,
  ...(date_added ? { date_added } : {}),
});
const folder = (name: string, children: unknown[]) => ({
  type: "folder" as const,
  name,
  children,
});

test("找到深层嵌套的收件箱夹，并读出条目", async () => {
  const path = await fixture("nested", {
    roots: {
      other: folder("其他书签", [
        folder("杂物", [
          folder("Zhandao待收录", [url("React 文档", "https://react.dev/a")]),
        ]),
      ]),
    },
  });

  const { entries, matchedFolders } = await readInbox(path);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.url, "https://react.dev/a");
  assert.equal(entries[0]?.title, "React 文档");
  assert.deepEqual(matchedFolders, ["other/其他书签/杂物/Zhandao待收录"]);
});

test("收件箱内的子文件夹也要递归收集，并记录所在路径", async () => {
  const path = await fixture("subfolders", {
    roots: {
      bookmark_bar: folder("书签栏", [
        folder("Zhandao待收录", [
          url("顶层", "https://example.com/top"),
          folder("以后再说", [url("嵌套", "https://example.com/deep")]),
        ]),
      ]),
    },
  });

  const { entries } = await readInbox(path);
  assert.deepEqual(
    entries.map((e) => [e.url, e.folderPath]),
    [
      ["https://example.com/top", "bookmark_bar/书签栏/Zhandao待收录"],
      ["https://example.com/deep", "bookmark_bar/书签栏/Zhandao待收录/以后再说"],
    ],
  );
});

test("Chrome 的 WebKit 时间戳换算成正确的 Date", async () => {
  const path = await fixture("timestamps", {
    roots: {
      other: folder("其他书签", [
        folder("Zhandao待收录", [
          url("纪元", "https://example.com/epoch", CHROME_TS_AT_UNIX_EPOCH),
          url("没有时间", "https://example.com/none"),
          url("时间是垃圾值", "https://example.com/junk", "not-a-number"),
        ]),
      ]),
    },
  });

  const { entries } = await readInbox(path);
  assert.equal(entries[0]?.addedAt?.toISOString(), "1970-01-01T00:00:00.000Z");
  assert.equal(entries[1]?.addedAt, null);
  assert.equal(entries[2]?.addedAt, null);
});

test("找不到收件箱夹时抛 InboxFolderNotFound", async () => {
  const path = await fixture("missing", {
    roots: { other: folder("其他书签", [url("随便", "https://example.com")]) },
  });
  await assert.rejects(() => readInbox(path), InboxFolderNotFound);
});

test("同名文件夹全部命中，条目合并，路径可区分", async () => {
  const path = await fixture("duplicate-folders", {
    roots: {
      bookmark_bar: folder("书签栏", [folder("Zhandao待收录", [url("甲", "https://a.example")])]),
      other: folder("其他书签", [folder("Zhandao待收录", [url("乙", "https://b.example")])]),
    },
  });

  const { entries, matchedFolders } = await readInbox(path);
  assert.equal(matchedFolders.length, 2);
  assert.deepEqual(entries.map((e) => e.title).sort(), ["乙", "甲"]);
});

test("忽略没有 url 字段的 url 节点，不因此崩溃", async () => {
  const path = await fixture("malformed", {
    roots: {
      other: folder("其他书签", [
        folder("Zhandao待收录", [
          { type: "url", name: "缺 url 字段" },
          null,
          { type: "什么玩意", name: "未知类型" },
          url("正常的", "https://ok.example"),
        ]),
      ]),
    },
  });

  const { entries } = await readInbox(path);
  assert.deepEqual(entries.map((e) => e.url), ["https://ok.example"]);
});

after(() => {
  if (dir) console.log(`fixtures: ${dir}`);
});
