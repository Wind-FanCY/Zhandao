/**
 * 速记入口：`npm run note -- "一句话"`
 *
 * 这是 ADR-0009 里的「轻动作」。设计目标是你在终端里骂 bug 的间隙能顺手敲完，
 * 所以它不需要服务在跑、不联网、不问你这条归属于哪份材料。
 */
import { EmptyQuickNote, appendQuickNote, readQuickNotes } from "../quicknotes/append.js";

const args = process.argv.slice(2);

if (args[0] === "--list") {
  const notes = await readQuickNotes();
  if (notes.length === 0) {
    console.log("还没有速记。");
  } else {
    console.log(`${notes.length} 条待归属的速记：\n`);
    for (const n of notes) {
      console.log(`  [${n.at.slice(0, 16).replace("T", " ")}] ${n.text}`);
    }
  }
  process.exit(0);
}

const text = args.join(" ");
try {
  const note = await appendQuickNote(text);
  console.log(`已记下：${note.text}`);
} catch (err) {
  if (err instanceof EmptyQuickNote) {
    console.error('用法：npm run note -- "你的一句话"');
    console.error("      npm run note -- --list");
    process.exit(1);
  }
  throw err;
}
