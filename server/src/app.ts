import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { readInbox, InboxFolderNotFound } from "./inbox/chrome-bookmarks.js";
import { extractArticles, type ExtractResult, type BatchItem } from "./inbox/extract.js";
import { writeMaterial } from "./materials/write.js";
import { appendProcessed, readProcessedUrls } from "./inbox/processed.js";
import { cacheExtraction, readCachedExtraction } from "./inbox/extract-cache.js";
import { readQuickNotes } from "./quicknotes/append.js";
import { appendNoteProcessed, readProcessedNoteIds } from "./quicknotes/processed.js";
import { writeAnnotation, EmptyAnnotation, MissingHostMaterial } from "./annotations/write.js";
import { buildMaterialsIndex, searchMaterials, getMaterial, listMaterials } from "./search/materials-index.js";

/**
 * 声明一个最小接口来表示可能有 flush 方法的 Response。
 * compression 中间件会给 Response 对象添加 flush 方法。
 */
interface Flushable {
  flush?: () => void;
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
const jobs = new Map<string, Job>();
let currentJobId: string | null = null;

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
      const maybeFlushable = listener as unknown as Flushable;
      maybeFlushable.flush?.();
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
export function createApp(inboxBookmarksPath?: string, fetchFn?: typeof fetch): Express {
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
      const [inboxResult, processedUrls] = await Promise.all([
        readInbox(inboxBookmarksPath),
        readProcessedUrls(),
      ]);

      // 过滤掉已处理的 URL
      const filtered = inboxResult.entries.filter((entry) => !processedUrls.has(entry.url));
      const filteredCount = inboxResult.entries.length - filtered.length;

      res.json({
        entries: filtered,
        matchedFolders: inboxResult.matchedFolders,
        filtered: filteredCount,
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

      // 获取收件箱条目
      const inboxResult = await readInbox(inboxBookmarksPath);
      const urls = inboxResult.entries.map((e) => e.url);

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
    const jobId = req.query.jobId as string | undefined;

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
      const { url, title } = req.body as Record<string, unknown>;

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
      const { url } = req.body as Record<string, unknown>;

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
      }));
      res.json({ materials });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/notes/pending
   * 列出待归属的**速记**（不在 quicknotes-processed.jsonl 里的那些），
   * 每条附上 BM25 直出的 3 个候选宿主**材料**。
   *
   * 每次请求都重建索引：材料只有几篇，缓存带来的「索引与磁盘不一致」风险
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

      const notes = pending.map((note) => {
        const candidates = searchMaterials(index, note.text, 3).map((m) => ({
          id: m.id,
          title: m.title,
          source: m.source,
          score: m.score,
        }));
        return { id: note.id, text: note.text, at: note.at, candidates };
      });

      res.json({ notes });
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

  return app;
}
