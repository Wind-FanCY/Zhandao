/**
 * 运行时初始化：处理代理和其他全局设置。
 *
 * 本地开发通常通过 http_proxy 环境变量走企业代理。Node 的 fetch（undici）默认不读该变量。
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
