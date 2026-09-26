import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { readInbox, InboxFolderNotFound, type InboxEntry } from "./inbox/chrome-bookmarks.js";
import { extractArticles, type ExtractResult, type BatchItem } from "./inbox/extract.js";
import { writeMaterial } from "./materials/write.js";
import { appendProcessed, readProcessedUrls } from "./inbox/processed.js";
import { cacheExtraction, readCachedExtraction } from "./inbox/extract-cache.js";
import { readQuickNotes } from "./quicknotes/append.js";
import { appendNoteProcessed, readProcessedNoteIds } from "./quicknotes/processed.js";
import { cacheDistilledQuery, readCachedQuery } from "./quicknotes/query-cache.js";
import { writeAnnotation, EmptyAnnotation, MissingHostMaterial } from "./annotations/write.js";
import { readAnnotations } from "./annotations/read.js";
import { buildMaterialsIndex, searchMaterials, getMaterial, listMaterials } from "./search/materials-index.js";
import { distillQuery, QueryDistillFailed } from "./model/distill-query.js";
import { MissingApiKey } from "./model/keywords.js";
import { appendArchived } from "./materials/archive.js";
import { dropMaterial, MaterialNotFound } from "./materials/drop.js";
import { computePool } from "./push/pool.js";
import { resolveTodaysPush } from "./push/today.js";
import { listDrills } from "./drills/list.js";
import { DrillExtractFailed } from "./model/extract-drills.js";
import { appendDrillRecord, readDrillVerdicts } from "./drills/records.js";
import { readCachedDrills } from "./drills/cache.js";
import { runAskNative } from "./qa/loop-native.js";
import { askOnceNative, NativeCallFailed, type NativeTurn } from "./model/answer-native.js";
import { appendAsk } from "./qa/asks.js";
import { ProtocolError } from "./qa/protocol.js";

/**
 * 声明一个最小接口来表示可能有 flush 方法的 Response。
 * compression 中间件会给 Response 对象添加 flush 方法。
 */
interface Flushable {
  flush: () => void;
}

/**
 * HTTP 请求（query / body）是本项目的第五处外部边界，`CLAUDE.md` 的边界表里补了这一行。
 * 它最经常被外部输入触达，却一度是唯一用 `as` 断言而非检查处理的一处。
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** `flush` 是 compression 中间件在运行时挂上去的，编译期不存在——所以只能运行时问。 */
function hasFlush(v: unknown): v is Flushable {
  return isRecord(v) && "flush" in v && typeof v.flush === "function";
}

/** 单个作业的状态跟踪 */
interface Job {
  jobId: string;
  urls: string[];
  results: Map<string, ExtractResult>;
  /** 监听该作业的 SSE 响应写入器 */
  listeners: Response[];
  completed: boolean;
}

/** 内存中维护的所有作业 */

/** 生成唯一的 jobId */
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/** 编码 SSE 数据行 */
function encodeSSEData(data: unknown): string {
  const lines = JSON.stringify(data).split("\n");
  return lines.map((line) => `data: ${line}`).join("\n") + "\n";
}

/** 向所有监听者广播事件 */
function broadcastEvent(job: Job, eventType: string, data: unknown): void {
  const lines = JSON.stringify(data).split("\n");
  let message = `event: ${eventType}\n`;
  for (const line of lines) {
    message += `data: ${line}\n`;
  }
  message += "\n";

  for (const listener of job.listeners) {
    try {
      listener.write(message);
      // 如果启用了 compression，必须 flush 以确保数据立刻发送。
      // compression 中间件会给 Response 对象添加 flush 方法，用来强制 flush 缓冲的数据。
      // 这是实测过的坑，不处理会导致 SSE 事件堆积在缓冲区中延迟发送。
      // 用类型守卫而非 `listener as unknown as Flushable`：双重断言是这份代码库里
      // 最强的「相信我」，而 flush 到底在不在完全取决于运行时有没有挂 compression。
      if (hasFlush(listener)) listener.flush();
    } catch (err) {
      // 写入失败，移除该监听者
      const idx = job.listeners.indexOf(listener);
      if (idx >= 0) {
        job.listeners.splice(idx, 1);
      }
    }
  }
}

/** 创建 Express 应用 */
/**
 * 读**收件箱**，减去已处理的 URL。
 *
 * 抽成函数而不是在两个端点各写一遍：原先 `GET /api/inbox` 过滤了、
 * `POST /api/inbox/fetch` 忘了过滤，于是抓取会把已**收录**的条目重抓一遍——
 * 其中三条是掘金，而掘金连续请求会返回空壳页（CLAUDE.md 有实测）。
 * 也就是说那个 bug 不只是浪费，它主动去踩已知的限流。
 * 进度分母还会与可见列表不一致（9 vs 3），看起来像卡住了。
 */
async function readPendingInbox(inboxBookmarksPath?: string): Promise<{
  entries: InboxEntry[];
  matchedFolders: string[];
  filteredCount: number;
}> {
  const [inboxResult, processedUrls] = await Promise.all([
    readInbox(inboxBookmarksPath),
    readProcessedUrls(),
  ]);
  const entries = inboxResult.entries.filter((entry) => !processedUrls.has(entry.url));
  return {
    entries,
    matchedFolders: inboxResult.matchedFolders,
    filteredCount: inboxResult.entries.length - entries.length,
  };
}

/**
 * @param distillFn 提炼「速记原文 → 检索查询」的实现，默认用真的 `distillQuery`（会调 DeepSeek）。
 *   供测试注入假实现，好让 `GET /api/notes/pending` 的测试离线跑。
 *
 * 这里原先还有一个 `fetchFn?: typeof fetch` 参数，**已删除**：它从声明那天起就没有
 * 任何地方读取过，而 `extract.ts` 也没有接收 fetch 的入口，所以它根本接不上。
 * 一个看起来像注入点、实际什么都不做的参数比没有更糟——有人传了 stub 进来，
 * 然后纳闷为什么测试还在打真实网络，而失效是静默的。要做 fetch 注入得先在
 * `extractArticle` 的 options 里开口子。
 */
export function createApp(
  inboxBookmarksPath?: string,
  distillFn?: (noteText: string) => Promise<string>,
  extractDrillsFn?: (
    candidates: { line: number; text: string }[],
  ) => Promise<{ line: number; question: string }[]>,
  // 第四个位置参数了，这个签名开始有味道——四个可选位置参数，调用方漏一个位置就静默错位。
  // 没有现在改成 options 对象，是因为那要同时动 index.ts 与全部测试，属于独立改动；
  // 再加第五个之前必须先改。**2026-09-26 切原生时刻意「替换」而不是「新增」，就是为了守住这句话。**
  askOnceNativeFn?: (messages: unknown[], toolSchemas: unknown[]) => Promise<NativeTurn>,
): Express {

  // 作业状态必须在 createApp 之内：原先是模块级的，于是所有 app 实例共享同一份，
  // 测试之间互相污染（一条测试起的作业会被下一条的 POST /fetch 当成「已有作业」返回）。
  // 生产只有一个 app 所以看不出来，但那是巧合，不是设计。
  const jobs = new Map<string, Job>();
  let currentJobId: string | null = null;
  const distill = distillFn ?? distillQuery;
  const app = express();

  // CORS 中间件：只允许 http://localhost:5173
  app.use(
    cors({
      origin: "http://localhost:5173",
      credentials: true,
    }),
  );

  // JSON 中间件
  app.use(express.json());

  /**
   * GET /api/inbox
   * 立即返回本地收件箱条目，过滤掉已处理的 URL。
   */
  app.get("/api/inbox", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await readPendingInbox(inboxBookmarksPath);

      res.json({
        entries: pending.entries,
        matchedFolders: pending.matchedFolders,
        filtered: pending.filteredCount,
      });
    } catch (err) {
      if (err instanceof InboxFolderNotFound) {
        return res.status(404).json({ error: err.message });
      }
      // 文件系统错误等
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/inbox/fetch
   * 启动后台抓取作业。如已有作业，返回现有的 jobId 和 total。
   */
  app.post("/api/inbox/fetch", async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 如果已有作业在运行，返回现有的
      if (currentJobId) {
        const job = jobs.get(currentJobId);
        if (job) {
          return res.json({
            jobId: job.jobId,
            total: job.urls.length,
          });
        }
      }

      // 只抓未处理的：已**收录**或已划掉的条目重抓毫无用途，还会去踩掘金的限流
      const pending = await readPendingInbox(inboxBookmarksPath);
      const urls = pending.entries.map((e) => e.url);

      if (urls.length === 0) {
        return res.json({
          jobId: "",
          total: 0,
        });
      }

      // 创建新作业
      const jobId = generateJobId();
      const job: Job = {
        jobId,
        urls,
        results: new Map(),
        listeners: [],
        completed: false,
      };

      jobs.set(jobId, job);
      currentJobId = jobId;

      // 在后台启动抓取（不 await）
      let succeeded = 0;
      let failed = 0;

      extractArticles(urls, {
        onProgress: (done: number, total: number, url: string) => {
          broadcastEvent(job, "progress", { done, total, url });
        },
        onItem: (item: BatchItem) => {
          // 单条结果回调：每个 URL 处理完后立即推送
          job.results.set(item.url, item.result);

          if (item.result.ok) {
            succeeded += 1;

            // 立刻将正文缓存到磁盘（不要等 30 秒清理）
            cacheExtraction(item.url, item.result.markdown).catch((err) => {
              // 缓存失败不应该影响用户界面，静默记录
              console.error(`Failed to cache extraction for ${item.url}:`, err);
            });

            // 发送成功结果，markdown 只传前 300 字
            const truncatedMarkdown = item.result.markdown.substring(0, 300);
            broadcastEvent(job, "item", {
              url: item.url,
              result: {
                ok: true,
                title: item.result.title,
                textLength: item.result.textLength,
                finalUrl: item.result.finalUrl,
                markdown: truncatedMarkdown,
              },
            });
          } else {
            failed += 1;
            // 发送失败结果
            broadcastEvent(job, "item", {
              url: item.url,
              result: item.result,
            });
          }
        },
      })
        .then(() => {
          // 广播完成事件
          broadcastEvent(job, "done", {
            total: urls.length,
            succeeded,
            failed,
          });

          job.completed = true;

          // 30 秒后清理作业和监听者
          setTimeout(() => {
            if (currentJobId === jobId) {
              currentJobId = null;
            }
            job.listeners.forEach((listener) => {
              try {
                listener.end();
              } catch (e) {
                // 已断开的连接，忽略
              }
            });
            jobs.delete(jobId);
          }, 30000);
        })
        .catch((err) => {
          // 未预期的错误，广播给所有监听者
          broadcastEvent(job, "done", {
            total: urls.length,
            succeeded,
            failed,
          });
          job.completed = true;
        });

      res.json({
        jobId,
        total: urls.length,
      });
    } catch (err) {
      if (err instanceof InboxFolderNotFound) {
        return res.status(404).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/inbox/events?jobId=...
   * SSE 订阅该作业的进度事件。
   */
  app.get("/api/inbox/events", (req: Request, res: Response, next: NextFunction) => {
    // Express 的 query 值可能是 string | string[] | ParsedQs | ParsedQs[]——
    // `?jobId=a&jobId=b` 时它是**数组**，而 `as string` 断言拦不住，
    // 下面的 `!jobId` 对数组恒为假（数组是 truthy），就会带着一个数组往下走。
    const rawJobId: unknown = req.query.jobId;
    const jobId = typeof rawJobId === "string" ? rawJobId : undefined;

    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId query parameter" });
    }

    const job = jobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "http://localhost:5173",
      "Access-Control-Allow-Credentials": "true",
    });

    // 加入监听者列表
    job.listeners.push(res);

    // 如果作业已完成，立刻发送完成事件
    if (job.completed) {
      const succeeded = Array.from(job.results.values()).filter((r) => r.ok).length;
      const failed = job.urls.length - succeeded;
      broadcastEvent(job, "done", {
        total: job.urls.length,
        succeeded,
        failed,
      });
    }

    // 处理客户端断开
    res.on("close", () => {
      const idx = job.listeners.indexOf(res);
      if (idx >= 0) {
        job.listeners.splice(idx, 1);
      }
    });
  });

  /**
   * POST /api/inbox/keep
   * 将条目标记为"留下"并写入材料文件。
   *
   * Request body:
   * { "url": "...", "title": "..." }
   *
   * 完整的正文从 .cache/ 读取。
   *
   * Response:
   * { "id": "...", "path": "..." } (201)
   * { "error": "..." } (400/409/410/500)
   *   410: 缓存中找不到该 URL 的正文（需要重新抓取）
   */
  app.post("/api/inbox/keep", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body;
      if (!isRecord(body)) {
        return res.status(400).json({ error: "Missing or invalid request body" });
      }
      const { url, title } = body;

      // 验证必需字段
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "Missing or invalid url" });
      }

      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Missing or empty title" });
      }

      // 检查该 URL 是否已处理
      const processedUrls = await readProcessedUrls();
      if (processedUrls.has(url)) {
        return res.status(409).json({ error: "URL already processed" });
      }

      // 从缓存读取完整的正文
      // 410 Gone: 缓存资源不存在，需要重新抓取
      const cachedMarkdown = await readCachedExtraction(url);
      if (cachedMarkdown === null) {
        return res.status(410).json({
          error: "Extracted content not found in cache. Please re-fetch the article.",
        });
      }

      // 写入材料文件
      const written = await writeMaterial({
        title: title.trim(),
        markdown: cachedMarkdown,
        source: url,
      });

      // 记录为已处理
      await appendProcessed({
        url,
        decision: "kept",
        at: new Date().toISOString(),
        materialId: written.id,
      });

      return res.status(201).json({
        id: written.id,
        path: written.path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/inbox/drop
   * 将条目标记为"划掉"。
   *
   * Request body:
   * { "url": "..." }
   *
   * Response:
   * { "ok": true } (200)
   * { "error": "..." } (400/409/500)
   */
  app.post("/api/inbox/drop", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: unknown = req.body;
      if (!isRecord(body)) {
        return res.status(400).json({ error: "Missing or invalid request body" });
      }
      const { url } = body;

      // 验证必需字段
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "Missing or invalid url" });
      }

      // 检查该 URL 是否已处理
      const processedUrls = await readProcessedUrls();
      if (processedUrls.has(url)) {
        return res.status(409).json({ error: "URL already processed" });
      }

      // 记录为已处理
      await appendProcessed({
        url,
        decision: "dropped",
        at: new Date().toISOString(),
      });

      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/materials
   * 全部**材料**的标题列表，供归属界面在检索没把正确宿主排进前三时浏览。
   * 「界面必须支持浏览，不能只有搜索」——见 CLAUDE.md。
   */
  app.get("/api/materials", async (req: Request, res: Response) => {
    try {
      const index = await buildMaterialsIndex();
      const materials = listMaterials(index).map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
        // `from` = 展开出这份**材料**的**索引页**（ADR-0010），供前端按系列分组折叠。
        // 那份 ADR 的 Consequences 早就点了名：同一系列的材料词汇高度重合、列表区分度低，
        // 「缓解在呈现层：候选里显示 from」。实测 49 篇里 41 篇共用一个 from，
        // 不分组的话整张列表 84% 是一堵同质的墙。非每份材料都有，可缺省。
        from: m.from,
      }));
      res.json({ materials });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/materials/pool
   * 当前推送池的完整列表（孤岛在前、留档在后，各自按 since 升序），
   * 供阅读视图浏览「还有哪些材料等着」——不止今天推的那一篇。
   *
   * 路由必须注册在 `GET /api/materials/:id` 之前：否则 "pool" 会被当成 :id 吃掉。
   */
  app.get("/api/materials/pool", async (req: Request, res: Response) => {
    try {
      const pool = await computePool();
      res.json({
        candidates: pool.map((c) => ({
          id: c.material.id,
          title: c.material.title,
          source: c.material.source,
          kind: c.kind,
          since: c.since,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/push/today
   * 今天该推的那一篇材料（孤岛优先，其次留档最早）。
   * `candidate: null` 是合法结果——池子空了，或池首是今天刚留档的（同日去重）。
   *
   * **用 `resolveTodaysPush` 而不是 `pickForPush`**：今天如果已经被 hook 推过，
   * 这里必须给出同一篇，不能因为轮转排序把它算成「已经推过、该轮到下一篇」了
   * ——那正是 2026-09-26 修的那个 bug（详见 `push/today.ts` 顶部注释）。
   */
  app.get("/api/push/today", async (req: Request, res: Response) => {
    try {
      const picked = await resolveTodaysPush();
      if (!picked) {
        return res.json({ candidate: null });
      }
      res.json({
        candidate: {
          id: picked.material.id,
          title: picked.material.title,
          source: picked.material.source,
          kind: picked.kind,
          since: picked.since,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/annotations
   * 全部**标注**的列表，独立于任何一份**材料**。
   *
   * 存在的理由：`CLAUDE.md`「界面必须支持浏览」——库里唯一值钱的那层（标注）此前
   * 一条浏览路径都没有，只能从「打开某篇材料之后的详情」里看到。
   * 单开端点而不是把 `annotations` 塞进 `GET /api/materials`：
   * 「列出全部标注」是一个独立的能力，塞进材料列表只会让那个端点的载荷随标注增长。
   *
   * 按 `at` 升序（最早的在前）：这条路径的目的之一是让本人发现「哪条已经想不起来了」，
   * 而最老的那条最可能是那一条；顺序稳定也是它的功能——本人靠位置认条目。
   */
  app.get("/api/annotations", async (req: Request, res: Response) => {
    try {
      const annotations = await readAnnotations();
      const sorted = [...annotations].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      res.json({
        annotations: sorted.map((a) => ({
          id: a.id,
          material: a.material,
          text: a.text,
          at: a.at,
          targets: a.targets,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/materials/:id
   * 一份材料的全文（不裁剪）+ 挂在它上面的全部标注（按 at 升序）。
   * 阅读视图打开一篇待处理的材料时用这个端点。
   */
  app.get("/api/materials/:id", async (req: Request, res: Response) => {
    try {
      const materialId = req.params.id;
      // Express 的 params 类型允许 string[]（通配符路由才会出现），typeof 收窄而非断言
      if (typeof materialId !== "string") {
        return res.status(404).json({ error: "Material not found" });
      }

      const [index, annotations] = await Promise.all([buildMaterialsIndex(), readAnnotations()]);
      const material = getMaterial(index, materialId);
      if (!material) {
        return res.status(404).json({ error: `Material ${materialId} not found` });
      }

      const hosted = annotations
        .filter((a) => a.material === materialId)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
        .map((a) => ({ id: a.id, text: a.text, at: a.at }));

      res.json({
        id: material.id,
        title: material.title,
        source: material.source,
        captured: material.captured,
        from: material.from,
        markdown: material.markdown,
        annotations: hosted,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/materials/:id/archive
   * **留档**：读完判定无可标注、但仍值得留在库中。允许对同一材料重复留档
   * （追加一条新记录）——`readArchivedIds` 只取最早那次用于排序，见 materials/archive.ts。
   *
   * Response: { "ok": true } (201)；材料不存在 404
   */
  app.post("/api/materials/:id/archive", async (req: Request, res: Response) => {
    try {
      const materialId = req.params.id;
      if (typeof materialId !== "string") {
        return res.status(404).json({ error: "Material not found" });
      }

      const index = await buildMaterialsIndex();
      if (!getMaterial(index, materialId)) {
        return res.status(404).json({ error: `Material ${materialId} not found` });
      }

      await appendArchived({ materialId, at: new Date().toISOString() });
      return res.status(201).json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/materials/:id/drop
   * 划掉一份材料：删文件 + 记日志。
   *
   * Response: { "ok": true } (200)；材料不存在 404
   */
  app.post("/api/materials/:id/drop", async (req: Request, res: Response) => {
    try {
      const materialId = req.params.id;
      if (typeof materialId !== "string") {
        return res.status(404).json({ error: "Material not found" });
      }

      await dropMaterial(materialId);
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof MaterialNotFound) {
        return res.status(404).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/materials/:id/annotate
   * 阅读视图里直接对当前材料写一条标注——宿主已知（就是这篇材料），不需要走
   * **归属**（速记 → 候选宿主 → 挑一个）那条路径；这是产生标注的第二条路径，并存不冲突。
   *
   * Request body: { "text": string }
   * Response: { "annotationId": "...", "path": "..." } (201)
   *   text 为空 → 400；材料不存在 → 400（说清是宿主不存在，与 /api/notes/:id/attach 一致）
   */
  app.post("/api/materials/:id/annotate", async (req: Request, res: Response) => {
    try {
      const materialId = req.params.id;
      if (typeof materialId !== "string") {
        return res.status(400).json({ error: "Missing material id" });
      }

      // 手写 typeof 收窄读 body 字段，不用 `as` 断言——外部输入不可信
      const body: unknown = req.body;
      let text: string | undefined;
      if (typeof body === "object" && body !== null) {
        if ("text" in body && typeof body.text === "string") text = body.text;
      }

      if (text === undefined || !text.trim()) {
        return res.status(400).json({ error: "Missing or empty text" });
      }

      const index = await buildMaterialsIndex();
      if (!getMaterial(index, materialId)) {
        return res.status(400).json({ error: `Host material ${materialId} not found` });
      }

      const written = await writeAnnotation({ materialId, text });
      return res.status(201).json({ annotationId: written.id, path: written.path });
    } catch (err) {
      if (err instanceof EmptyAnnotation || err instanceof MissingHostMaterial) {
        return res.status(400).json({ error: err.message });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/materials/:id/drills
   * 一份材料的**练题**清单（提取自正文、带定位锚点），合并每道题上次自评的会/不会。
   * 缓存命中就不调模型——见 `drills/list.ts`。供「阅读」视图的**预练**入口使用。
   *
   * Response: 200 { materialId, drills: [{ id, question, anchor, anchorLine, lastKnown }] }
   *           404 材料不存在
   *           502 { error, code: "drill_extract_failed" } 提取失败（含缺 API key 的情况——
   *             对调用方而言都是「这次要不到练题清单」，处置相同：提示稍后重试）
   */
  app.get("/api/materials/:id/drills", async (req: Request, res: Response) => {
    try {
      const materialId = req.params.id;
      if (typeof materialId !== "string") {
        return res.status(404).json({ error: "Material not found" });
      }

      const index = await buildMaterialsIndex();
      const material = getMaterial(index, materialId);
      if (!material) {
        return res.status(404).json({ error: `Material ${materialId} not found` });
      }

      const drills = await listDrills(materialId, material.markdown, extractDrillsFn);

      res.json({
        materialId,
        drills: drills.map((d) => ({
          id: d.id,
          question: d.question,
          anchor: d.anchor,
          anchorLine: d.anchorLine,
          lastKnown: d.lastKnown,
        })),
      });
    } catch (err) {
      if (err instanceof DrillExtractFailed || err instanceof MissingApiKey) {
        return res.status(502).json({ error: err.message, code: "drill_extract_failed" });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/drills/record
   * 记一条**练题记录**（本人对一道练题的一次自评：会 / 不会）。不进复习调度、
   * 不进推送池（ADR-0011）——这里只管落盘。
   *
   * **drillId 刻意放 body 而不是 URL**：drillId 形如 `材料id#锚点slug`，含 `#`，
   * 放进 URL 路径会被浏览器/服务端当成 fragment 分隔符截断，服务端根本收不到完整 id。
   *
   * Request body: { drillId: string, materialId: string, known: boolean }
   * Response: { ok: true } (201)；body 形状不对 400
   */
  app.post("/api/drills/record", async (req: Request, res: Response) => {
    try {
      // 手写 typeof 收窄读 body 字段，不用 `as` 断言——外部输入不可信
      const body: unknown = req.body;
      let drillId: string | undefined;
      let materialId: string | undefined;
      let known: boolean | undefined;
      if (typeof body === "object" && body !== null) {
        if ("drillId" in body && typeof body.drillId === "string") drillId = body.drillId;
        if ("materialId" in body && typeof body.materialId === "string") {
          materialId = body.materialId;
        }
        if ("known" in body && typeof body.known === "boolean") known = body.known;
      }

      if (drillId === undefined || !drillId.trim()) {
        return res.status(400).json({ error: "Missing or empty drillId" });
      }
      if (materialId === undefined || !materialId.trim()) {
        return res.status(400).json({ error: "Missing or empty materialId" });
      }
      if (known === undefined) {
        return res.status(400).json({ error: "Missing or invalid known" });
      }

      await appendDrillRecord({ drillId, materialId, known, at: new Date().toISOString() });
      return res.status(201).json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/drills/status
   * 全部**材料**的**预练**状态概览，供「预练」标签页用来列出全部材料——
   * 不能用 `GET /api/materials/pool`：池子按定义排除已被**标注**指向的材料
   * （`computePool` 会过滤掉），于是一写标注那篇材料就从池子消失，
   * 没法回去继续预练同一份材料里剩下的**练题**。这里改用 `listMaterials`，
   * 顺序稳定（按标题排序）是它的功能而非细节，见 CLAUDE.md。
   *
   * **绝对不在这里调模型。** 未缓存的材料只报 `cached: false` + 三个 0；
   * 真正的提取只在 `GET /api/materials/:id/drills`（用户点开某一篇材料的预练时）
   * 发生。这个端点一次请求要遍历全部材料，顺手提取会在一次请求里
   * 触发几十次 DeepSeek 调用——那是「材料不出题」同一类错误的镜像版本
   * （这里是「浏览不该触发生成」）。
   *
   * `readDrillVerdicts()` 只读一次 `drill-records.jsonl`，不在循环里对每份材料重读。
   *
   * Response: 200 { materials: [{ materialId, title, cached, total, unknown, unattempted }] }
   *   `total` 不一定等于 `unknown + unattempted`——标了「会」的练题两者都不算。
   */
  app.get("/api/drills/status", async (req: Request, res: Response) => {
    try {
      const index = await buildMaterialsIndex();
      const materials = listMaterials(index);
      const verdicts = await readDrillVerdicts();

      const statuses = await Promise.all(
        materials.map(async (m) => {
          const drills = await readCachedDrills(m.id);
          if (drills === null) {
            return {
              materialId: m.id,
              title: m.title,
              // 供前端按**索引页**分组折叠，理由同 `GET /api/materials`（ADR-0010）
              from: m.from,
              cached: false,
              total: 0,
              unknown: 0,
              unattempted: 0,
            };
          }

          let unknown = 0;
          let unattempted = 0;
          for (const d of drills) {
            const record = verdicts.get(d.id);
            if (record === undefined) {
              unattempted += 1;
            } else if (record.known === false) {
              unknown += 1;
            }
          }

          return {
            materialId: m.id,
            title: m.title,
            from: m.from,
            cached: true,
            total: drills.length,
            unknown,
            unattempted,
          };
        }),
      );

      res.json({ materials: statuses });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/notes/pending
   * 列出待归属的**速记**（不在 quicknotes-processed.jsonl 里的那些）。
   *
   * 候选宿主不再直接拿速记原文去 BM25——原文里的填充词把信号淹了（实测：
   * 原文当查询连前 12 都进不去，「undici 不读 http_proxy 代理」这八个字排第 1）。
   * 所以先用模型把原文提炼成短查询，再拿查询去搜。见 CLAUDE.md「归属链路的实现约束」。
   *
   * 每条速记的提炼结果永久缓存在 `.cache/`（键是速记 id），命中就不再调模型。
   * 多条速记并发提炼：抓取要顺序化是因为站点限流，模型 API 没有这个理由。
   *
   * 每次请求都重建材料索引：材料只有几篇，缓存带来的「索引与磁盘不一致」风险
   * 比重建的开销更值得避免。
   */
  app.get("/api/notes/pending", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [allNotes, processedIds, index] = await Promise.all([
        readQuickNotes(),
        readProcessedNoteIds(),
        buildMaterialsIndex(),
      ]);

      const pending = allNotes
        .filter((note) => !processedIds.has(note.id))
        .sort((a, b) => a.at.localeCompare(b.at));

      const notes = await Promise.all(
        pending.map(async (note) => {
          const cached = await readCachedQuery(note.id);

          // `query` 只在下面两个分支里各赋值一次（要么缓存命中，要么提炼成功），
          // 提炼失败的分支直接 return，所以走到下面 searchMaterials 时它必已被赋值。
          let query: string;
          if (cached !== null) {
            query = cached;
          } else {
            try {
              query = await distill(note.text);
              // 缓存失败不应该影响本次响应：下次请求会重新调模型，代价只是多一次往返
              await cacheDistilledQuery(note.id, query).catch((err) => {
                console.error(`Failed to cache distilled query for ${note.id}:`, err);
              });
            } catch (err) {
              // 提炼失败：不能退回用原文搜——那会产出三个看起来正常、实际全错的候选，
              // 而使用者不知道提炼失败了。单条失败不能影响其他条目，故只 catch 在这条闭包内。
              //
              // 预期失败（模型返回空、缺 key）与意外错误（我们自己的 bug）**处置相同**，
              // 但意外错误必须留下痕迹：否则代码里一个 TypeError 会伪装成「模型提炼失败」，
              // 界面照常提示、而真正的原因永远查不到。静默失效是这个项目反复吃过的亏。
              if (err instanceof QueryDistillFailed || err instanceof MissingApiKey) {
                console.warn(`提炼失败（预期路径）note=${note.id}: ${err.message}`);
              } else {
                console.error(`提炼时发生意外错误 note=${note.id}——这不是模型的问题：`, err);
              }
              return {
                id: note.id,
                text: note.text,
                at: note.at,
                query: "",
                queryOk: false,
                candidates: [],
              };
            }
          }

          const candidates = searchMaterials(index, query, 3).map((m) => ({
            id: m.id,
            title: m.title,
            source: m.source,
            score: m.score,
          }));
          return { id: note.id, text: note.text, at: note.at, query, queryOk: true, candidates };
        }),
      );

      res.json({ notes });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/search?q=...&limit=...
   * 供归属界面在人改了提炼出的查询之后重搜。
   *
   * Query: q（必填）、limit（可选，默认 3，上限 20）
   * Response: { candidates: [{ id, title, source, score }] } (200)
   *           { error: "..." } (400)
   */
  app.get("/api/search", async (req: Request, res: Response) => {
    try {
      // req.query 的值类型允许 string | ParsedQs | (string | ParsedQs)[] | undefined，
      // 手写 typeof 收窄而不是 `as string`——外部输入不可信。
      const qRaw = req.query.q;
      const q = typeof qRaw === "string" ? qRaw.trim() : "";
      if (q.length === 0) {
        return res.status(400).json({ error: "Missing or empty q" });
      }

      let limit = 3;
      const limitRaw = req.query.limit;
      if (typeof limitRaw === "string") {
        const parsedLimit = Number(limitRaw);
        if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
          limit = Math.min(Math.trunc(parsedLimit), 20);
        }
      }

      const index = await buildMaterialsIndex();
      const candidates = searchMaterials(index, q, limit).map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
        score: m.score,
      }));

      res.json({ candidates });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/notes/:id/attach
   * 把一条**速记**归属到某份**材料**上，使它成为一条**标注**。
   *
   * Request body: { "text": string, "materialId": string }
   * Response: { "annotationId": "...", "path": "..." } (201)
   */
  app.post(
    "/api/notes/:id/attach",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const noteId = req.params.id;
        // Express 的 params 类型允许 string[]（通配符路由才会出现）；本路由只声明了
        // `:id`，实际不会是数组，但仍需 typeof 收窄而不是断言掉这个可能性
        if (typeof noteId !== "string") {
          return res.status(404).json({ error: "Quicknote not found" });
        }

        const [allNotes, processedIds] = await Promise.all([
          readQuickNotes(),
          readProcessedNoteIds(),
        ]);

        const note = allNotes.find((n) => n.id === noteId);
        if (!note) {
          return res.status(404).json({ error: `Quicknote ${noteId} not found` });
        }

        if (processedIds.has(noteId)) {
          return res.status(409).json({ error: "Quicknote already processed" });
        }

        // 手写 typeof 收窄读 body 字段，不用 `as` 断言——express 的 req.body 是外部数据，
        // 形状不可信（这一点与 frontmatter 那条边界同理）
        const body: unknown = req.body;
        let text: string | undefined;
        let materialId: string | undefined;
        if (typeof body === "object" && body !== null) {
          if ("text" in body && typeof body.text === "string") text = body.text;
          if ("materialId" in body && typeof body.materialId === "string") {
            materialId = body.materialId;
          }
        }

        if (text === undefined || !text.trim()) {
          return res.status(400).json({ error: "Missing or empty text" });
        }

        if (materialId === undefined || !materialId.trim()) {
          return res.status(400).json({ error: "Missing or empty materialId" });
        }

        // 宿主材料必须存在——归属给出的是「恰好一份材料」这条必然的边
        const index = await buildMaterialsIndex();
        if (!getMaterial(index, materialId)) {
          return res.status(400).json({ error: `Host material ${materialId} not found` });
        }

        // 先写文件、再记日志：日志记了而文件没写，就等于凭空丢失一条标注
        const written = await writeAnnotation({ materialId, text });

        await appendNoteProcessed({
          quickNoteId: noteId,
          decision: "attached",
          at: new Date().toISOString(),
          annotationId: written.id,
        });

        return res.status(201).json({ annotationId: written.id, path: written.path });
      } catch (err) {
        if (err instanceof EmptyAnnotation) {
          return res.status(400).json({ error: err.message });
        }
        if (err instanceof MissingHostMaterial) {
          return res.status(400).json({ error: err.message });
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        return res.status(500).json({ error: message });
      }
    },
  );

  /**
   * POST /api/notes/:id/drop
   * 把一条**速记**标记为「划掉」，无 body。
   *
   * Response: { "ok": true } (200)
   */
  app.post("/api/notes/:id/drop", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const noteId = req.params.id;
      if (typeof noteId !== "string") {
        return res.status(404).json({ error: "Quicknote not found" });
      }

      const [allNotes, processedIds] = await Promise.all([
        readQuickNotes(),
        readProcessedNoteIds(),
      ]);

      const note = allNotes.find((n) => n.id === noteId);
      if (!note) {
        return res.status(404).json({ error: `Quicknote ${noteId} not found` });
      }

      if (processedIds.has(noteId)) {
        return res.status(409).json({ error: "Quicknote already processed" });
      }

      await appendNoteProcessed({
        quickNoteId: noteId,
        decision: "dropped",
        at: new Date().toISOString(),
      });

      return res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/ask —— **提问**：一条手写的 agent 循环，检索**材料**后给出带出处的答案。
   *
   * **流式直返，刻意不照抄 `/api/inbox/events` 那套 job 表**：那里需要 job 表是因为抓取是
   * 后台作业、可能多方订阅、订阅者来得比结果晚；**这里请求本身就是订阅**，
   * 建一张表只会多一处要清理的内存。
   *
   * SSE 事件三种：`step`（循环每一轮在做什么，**这是这个端点的主要价值，不是加载动画**）、
   * `done`、`error`。`done` 之后立刻 `res.end()`。
   *
   * **注意错误处理的分界**：头发出去之后就不能再改状态码了，所以 body 校验必须在
   * `writeHead` 之前；之后的任何失败只能作为 `error` 事件流出去。
   */
  app.post("/api/ask", async (req: Request, res: Response) => {
    // 手写收窄读 body——HTTP 请求是第五处外部边界，不用 `as` 断言。
    // 没有 Content-Type 时 express.json() 不解析，req.body 是 undefined，isRecord 挡住。
    const body: unknown = req.body;
    const question =
      isRecord(body) && typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      return res.status(400).json({ error: "Missing or empty question" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "http://localhost:5173",
      "Access-Control-Allow-Credentials": "true",
    });

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // compression 中间件会缓冲，不 flush 的话步骤事件会攒到最后一起到——
      // 那正好毁掉这个端点唯一的价值（看见循环在转）。
      if (hasFlush(res)) res.flush();
    };

    try {
      const index = await buildMaterialsIndex();
      // **走原生 `tool_calls` 那条路**（2026-09-26 起，试用期）。
      // 依据是对照实验：库外难题上手搓协议格式错误率 44%、原生 0/9，且原生少约 15% 模型调用。
      // **手搓那条没有删，`npm run ask-compare` 仍然同时跑两条**——改回去就是把这里
      // 换回 `runAsk` + `askOnce`。数字与完整权衡见 `docs/findings.md`。
      const result = await runAskNative(question, {
        ctx: { index },
        askOnceNative: askOnceNativeFn ?? askOnceNative,
        onStep: (step) => {
          const a = step.action;
          // 判别联合按 kind 收窄取「细节」，不用 `as`
          const detail =
            a.kind === "search"
              ? a.query
              : a.kind === "outline"
                ? (getMaterial(index, a.materialId)?.title ?? a.materialId)
                : a.kind === "read"
                  ? `${getMaterial(index, a.materialId)?.title ?? a.materialId} · L${a.line}`
                  : a.kind === "none"
                    ? a.reason
                    : a.kind === "protocol_error"
                      ? a.message
                      : "";
          send("step", {
            round: step.round,
            kind: a.kind,
            detail,
            summary: step.resultSummary,
            // 成功的 read 才有：未截断的原文，界面拿它渲染「出处原文」。
            // 这是整条链路里唯一会把材料正文发给前端的地方，刻意只发读到的那一段。
            ...(step.source ? { source: step.source } : {}),
          });
        },
      });

      // 循环实际搜过的词——判别联合里只有 search 有 query，用守卫收窄而非 filter + 断言
      const queries: string[] = [];
      for (const step of result.steps) {
        if (step.action.kind === "search") queries.push(step.action.query);
      }

      const found = result.outcome === "answered";

      // **提问记录**：只存问题、搜过的词、引用和「库里有没有」，不存答案正文（CLAUDE.md）。
      //
      // **`aborted` 不落盘**，这是有意的：`found:false` 在本项目里是**收录信号**，
      // 而「模型没按格式说话」不提供关于库的任何信息。记下去就是造一条假证据，
      // 而 `asks.jsonl` 是**不可再生**的——假证据会一直躺在那儿误导人。
      // **没有记录好过一条假记录。**
      if (result.outcome === "aborted") {
        console.warn(`[ask] 本次未问成（outcome=aborted），不写提问记录：${question}`);
      } else {
        // 落盘失败不该吞掉已经算出来的答案，所以单独 catch。
        try {
          await appendAsk({
            question,
            at: new Date().toISOString(),
            queries,
            cites: result.cites,
            found,
            rounds: result.rounds,
          });
        } catch (logErr) {
          console.error("[ask] 提问记录落盘失败（答案照常返回）:", logErr);
        }
      }

      send("done", {
        answer: result.answer,
        cites: result.cites.map((id) => ({
          materialId: id,
          title: getMaterial(index, id)?.title ?? id,
        })),
        rounds: result.rounds,
        hitLimit: result.hitLimit,
        found,
        // 界面必须能区分「库里没有」和「这次没问成」——前者该去收录，后者该重问一次
        outcome: result.outcome,
      });
    } catch (err) {
      const message =
        err instanceof NativeCallFailed || err instanceof MissingApiKey || err instanceof ProtocolError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      send("error", { error: message });
    } finally {
      res.end();
    }
  });

  return app;
}
