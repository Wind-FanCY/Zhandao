import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { readInbox, InboxFolderNotFound } from "./inbox/chrome-bookmarks.js";
import { extractArticles, type ExtractResult, type BatchItem } from "./inbox/extract.js";

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
   * 立即返回本地收件箱条目，不做任何抓取。
   */
  app.get("/api/inbox", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await readInbox(inboxBookmarksPath);
      res.json({
        entries: result.entries,
        matchedFolders: result.matchedFolders,
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

  return app;
}
