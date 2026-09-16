import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { dump as yamlDump } from "js-yaml";
import { resolveDataDir } from "../data-dir.js";
import { sanitizeForFilename } from "../filename.js";

export interface NewAnnotation {
  materialId: string;
  text: string;
}

export interface WrittenAnnotation {
  id: string;
  path: string;
}

/** text trim 后为空——**标注**的正文就是本人写的理解，空的没有意义 */
export class EmptyAnnotation extends Error {}

/** materialId trim 后为空——**归属**给出的是「恰好一份材料」这条必然的边，不能没有宿主 */
export class MissingHostMaterial extends Error {}

/**
 * 将一条**标注**写入磁盘。
 *
 * 文件路径：`<dataDir>/annotations/<ulid>-<摘要>.md`，摘要取正文前 24 字清理而来。
 *
 * frontmatter 恰好四个字段：id / material / targets / at。
 * `targets` 恒为空数组——**关联**的逻辑不在这条链路里实现，见 CLAUDE.md「功能优先级」。
 *
 * 与 materials/write.ts 同款：原子写入（临时文件 + rename），失败清理临时文件。
 */
export async function writeAnnotation(a: NewAnnotation): Promise<WrittenAnnotation> {
  const text = a.text.trim();
  if (text.length === 0) {
    throw new EmptyAnnotation("标注内容为空");
  }

  const materialId = a.materialId.trim();
  if (materialId.length === 0) {
    throw new MissingHostMaterial("缺少宿主材料");
  }

  const dataDir = resolveDataDir();
  const annotationsDir = resolve(dataDir, "annotations");

  // 确保 annotations 目录存在
  await mkdir(annotationsDir, { recursive: true });

  // 生成 ULID
  const id = ulid();

  // 摘要取正文前 24 字清理而来，为空则只用 ulid（与 materials/write.ts 的标题规则一致）
  const summary = sanitizeForFilename(text, 24);
  const filename = summary ? `${id}-${summary}.md` : `${id}.md`;
  const filepath = resolve(annotationsDir, filename);

  // targets 恒为空数组，用显式变量声明标注类型而非 `as` 断言
  const targets: string[] = [];

  // 构建 frontmatter，字段顺序固定：id / material / targets / at
  const frontmatter = {
    id,
    material: materialId,
    targets,
    at: new Date().toISOString(),
  };

  const frontmatterStr = yamlDump(frontmatter, {
    // -1 才是「不限宽、不换行」；见 materials/write.ts 同一处的注释与踩坑记录
    lineWidth: -1,
  });

  const content = `---\n${frontmatterStr}---\n\n${text}`;

  // 原子写入：先写到临时文件，再 rename
  const tempFilename = `${filename}.tmp`;
  const tempFilepath = resolve(annotationsDir, tempFilename);

  try {
    await writeFile(tempFilepath, content, "utf-8");
    await rename(tempFilepath, filepath);
  } catch (err) {
    try {
      await unlink(tempFilepath);
    } catch {
      // 临时文件本就不存在或已清理，忽略
    }
    throw err;
  }

  return {
    id,
    path: filepath,
  };
}
