/**
 * 运行时初始化：处理代理和其他全局设置。
 *
 * 本机出网走一个本地代理（http_proxy=http://127.0.0.1:7897），而非企业出口代理——
 * 区别要紧：本地代理是一个自己跑的进程，它可能没开。
 * 而 http_proxy 只是 Unix 世界的民间约定，不是系统设置：curl / git / npm 都读它，
 * Node 的 fetch（undici）默认不读。这是 undici 的明确立场，不是缺陷。
 * 改用显式的 setGlobalDispatcher(new EnvHttpProxyAgent()) 的原因：
 *
 * 1. 有多条启动路径（dev server、launchd 脚本、测试），环境变量易被忽略。
 * 2. 失效是静默的，表现为「这篇抓不到」，容易误判成网站问题。
 *
 * 实测数据（需要代理的站点）：
 *   - 不带处理：10.5s 超时 + 3 次重试 = 30 秒白烧
 *   - 环境变量：1.8s 成功（但容易被忘）
 *   - EnvHttpProxyAgent：1.7s 成功（显式、可靠）
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * 初始化代理。应当在应用启动的最早阶段调用，在任何网络请求之前。
 */
export function initializeProxyAgent(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

/**
 * 加载 `code/.env`（模型 API key 在里面）。
 *
 * Node 自带 `process.loadEnvFile`，不需要 dotenv。文件不存在时静默跳过——
 * 大部分命令（收录、检索、评估）不需要 key，不该因为缺 .env 就跑不起来。
 */
export function loadEnv(): void {
  try {
    process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
  } catch {
    // .env 不存在或不可读：不是错误
  }
}

/**
 * 一次把运行时准备好：读 `.env`，再装代理。**所有入口只该调这一个函数。**
 *
 * 为什么不让调用方自己调那两个——实测教训：8 个入口里只有 1 个记得调 `loadEnv()`，
 * 于是 `index.ts` 启动的服务从来没读过 `.env`，归属界面的模型提炼直接报
 * 「未设置 DEEPSEEK_API_KEY」。两个必须一起调的初始化就不该是两个函数。
 *
 * 顺序无关紧要（实测：`EnvHttpProxyAgent` 是每次请求读环境变量，不是构造时快照一次），
 * 但先读 .env 是直觉顺序，而且 API key 本来就只有这一条路进来。
 */
export function initializeRuntime(): void {
  loadEnv();
  initializeProxyAgent();
}
