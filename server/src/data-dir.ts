import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

/**
 * 解析数据目录的路径。
 *
 * 优先级：
 * 1. process.env.ZHANDAO_DATA_DIR（可为相对路径，相对 cwd 解析）
 * 2. 默认值：Zhandao/data（相对于代码仓库根），即代码仓库的兄弟目录
 *
 * 注意：必须使用 import.meta.url 推导默认路径，绝不能用 __dirname（ESM 中不存在）。
 */
export function resolveDataDir(): string {
  // 环境变量优先
  if (process.env.ZHANDAO_DATA_DIR) {
    const envPath = process.env.ZHANDAO_DATA_DIR;
    // 如果是相对路径，相对 cwd 解析
    if (!envPath.startsWith("/")) {
      return resolve(process.cwd(), envPath);
    }
    return envPath;
  }

  // 默认：代码仓库兄弟目录 Zhandao/data
  // import.meta.url 是当前文件的绝对路径，格式为 file:///...
  const currentFilePath = fileURLToPath(import.meta.url);
  // 获取 server/src/ 目录
  const serverSrcDir = dirname(currentFilePath);
  // 获取 server/ 目录
  const serverDir = dirname(serverSrcDir);
  // 获取 code/ 目录
  const codeDir = dirname(serverDir);
  // 获取 Zhandao/ 目录
  const zhandaoDir = dirname(codeDir);
  // data 目录
  return resolve(zhandaoDir, "data");
}
