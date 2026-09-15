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
