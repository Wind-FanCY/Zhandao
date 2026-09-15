import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 收件箱是 Chrome 的一个书签夹——见 ADR-0002。 */
export const INBOX_FOLDER_NAME = "Zhandao待收录";

const DEFAULT_BOOKMARKS_PATH = join(
  homedir(),
  "Library/Application Support/Google/Chrome/Default/Bookmarks",
);

/** Chrome 书签文件的节点。只声明我们实际读的字段。 */
type BookmarkNode = {
  type: "url" | "folder";
  name: string;
  url?: string;
  children?: BookmarkNode[];
  date_added?: string;
};

/** 收件箱里的一条候选内容。注意它还不是**材料**——尚未过闸。 */
export type InboxEntry = {
  title: string;
  url: string;
  /** 所在书签夹的完整路径，用于排查同名夹子 */
  folderPath: string;
  addedAt: Date | null;
};

export class InboxFolderNotFound extends Error {}

/** Chrome 时间戳是自 1601-01-01 起的微秒数（WebKit epoch）。 */
function parseChromeTimestamp(raw: string | undefined): Date | null {
  if (!raw) return null;
  const micros = Number(raw);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;
  return new Date(micros / 1000 - WEBKIT_EPOCH_OFFSET_MS);
}

function isBookmarkNode(value: unknown): value is BookmarkNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<BookmarkNode>;
  return (node.type === "folder" || node.type === "url") && typeof node.name === "string";
}

/**
 * 递归找出所有叫 `name` 的文件夹。
 * CLAUDE.md 要求不假设它在哪一层，所以全树扫描，并把同名命中全部返回。
 */
function findFolders(
  node: BookmarkNode,
  name: string,
  ancestry: string[],
  out: { folder: BookmarkNode; path: string }[],
): void {
  if (node.type !== "folder") return;
  const here = [...ancestry, node.name];
  if (node.name === name) out.push({ folder: node, path: here.join("/") });
  for (const child of node.children ?? []) {
    if (isBookmarkNode(child)) findFolders(child, name, here, out);
  }
}

/** 收集一个子树下所有的 url 节点，子文件夹里的也算。 */
function collectUrls(node: BookmarkNode, folderPath: string, out: InboxEntry[]): void {
  if (node.type === "url") {
    if (node.url) {
      out.push({
        title: node.name || node.url,
        url: node.url,
        folderPath,
        addedAt: parseChromeTimestamp(node.date_added),
      });
    }
    return;
  }
  const nested = `${folderPath}/${node.name}`;
  for (const child of node.children ?? []) {
    if (isBookmarkNode(child)) collectUrls(child, nested, out);
  }
}

export type ReadInboxResult = {
  entries: InboxEntry[];
  /** 命中的同名文件夹路径。多于一个时调用方应当提醒用户。 */
  matchedFolders: string[];
  bookmarksPath: string;
};

export async function readInbox(bookmarksPath?: string): Promise<ReadInboxResult> {
  const path =
    bookmarksPath ?? process.env.CHROME_BOOKMARKS_PATH ?? DEFAULT_BOOKMARKS_PATH;

  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const roots =
    typeof parsed === "object" && parsed !== null
      ? ((parsed as { roots?: Record<string, unknown> }).roots ?? {})
      : {};

  const matches: { folder: BookmarkNode; path: string }[] = [];
  for (const [rootKey, rootNode] of Object.entries(roots)) {
    if (isBookmarkNode(rootNode)) findFolders(rootNode, INBOX_FOLDER_NAME, [rootKey], matches);
  }

  if (matches.length === 0) {
    throw new InboxFolderNotFound(
      `Chrome 书签里找不到文件夹「${INBOX_FOLDER_NAME}」（已扫描 ${path}）`,
    );
  }

  const entries: InboxEntry[] = [];
  for (const { folder, path: folderPath } of matches) {
    for (const child of folder.children ?? []) {
      if (isBookmarkNode(child)) collectUrls(child, folderPath, entries);
    }
  }

  return { entries, matchedFolders: matches.map((m) => m.path), bookmarksPath: path };
}
