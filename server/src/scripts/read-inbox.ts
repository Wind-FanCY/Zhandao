/**
 * 第 1 步的验证脚本：把收件箱里的条目打印出来。
 * 用法：npm run inbox
 */
import { initializeProxyAgent } from "../runtime.js";
import {
  INBOX_FOLDER_NAME,
  InboxFolderNotFound,
  readInbox,
} from "../inbox/chrome-bookmarks.js";

// 在任何网络请求之前初始化代理
initializeProxyAgent();

try {
  const { entries, matchedFolders, bookmarksPath } = await readInbox();

  console.log(`书签文件：${bookmarksPath}`);
  console.log(`命中文件夹：${matchedFolders.join(", ")}`);
  if (matchedFolders.length > 1) {
    console.warn(`⚠️  有 ${matchedFolders.length} 个同名文件夹，条目已合并。`);
  }
  console.log(`\n「${INBOX_FOLDER_NAME}」共 ${entries.length} 条：\n`);

  const seen = new Map<string, number>();
  entries.forEach((entry, i) => {
    seen.set(entry.url, (seen.get(entry.url) ?? 0) + 1);
    const day = entry.addedAt ? entry.addedAt.toISOString().slice(0, 10) : "????-??-??";
    console.log(`${String(i + 1).padStart(2)}. [${day}] ${entry.title}`);
    console.log(`    ${entry.url}`);
  });

  const dupes = [...seen].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    console.warn(`\n⚠️  ${dupes.length} 个重复 URL，过闸时需去重。`);
  }
} catch (err) {
  if (err instanceof InboxFolderNotFound) {
    console.error(`✗ ${err.message}`);
    console.error(`  请在 Chrome 里建一个名为「${INBOX_FOLDER_NAME}」的书签夹。`);
    process.exit(1);
  }
  if (err instanceof Error && "code" in err && err.code === "ENOENT") {
    console.error(`✗ 找不到 Chrome 书签文件：${err.message}`);
    console.error(`  若用的不是默认 profile，在 .env 里设 CHROME_BOOKMARKS_PATH。`);
    process.exit(1);
  }
  throw err;
}
