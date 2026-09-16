/**
 * 速记入口：`npm run note -- "一句话"`
 *
 * 这是 ADR-0009 里的「轻动作」。设计目标是你在终端里骂 bug 的间隙能顺手敲完，
 * 所以它不需要服务在跑、不联网、不问你这条归属于哪份材料。
 */
import { EmptyQuickNote, appendQuickNote, readQuickNotes } from "../quicknotes/append.js";
import { readProcessedNoteIds } from "../quicknotes/processed.js";

const args = process.argv.slice(2);

if (args[0] === "--list") {
  // 必须减去已处理的那些。quicknotes.jsonl 是追加式的，已归属或已丢弃的行仍在文件里，
  // 直接数行数会让这个命令一直报「2 条待归属」——一个会骗人的命令比没有命令更糟。
  const [all, processed] = await Promise.all([readQuickNotes(), readProcessedNoteIds()]);
  const notes = all.filter((n) => !processed.has(n.id));
  if (notes.length === 0) {
    const tail = processed.size > 0 ? `（已处理 ${processed.size} 条）` : "";
    console.log(`没有待归属的速记。${tail}`);
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
