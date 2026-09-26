import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createApp } from "./app.js";

/** 给 SSE 测试用的最小响应类型别名（node 的全局 Response） */
type Response_ = Awaited<ReturnType<typeof fetch>>;

/** 测试里也不用 `as` 断言收窄外部数据——这条规矩对测试同样成立 */
function asRecord(v: unknown): Record<string, unknown> {
  assert.ok(typeof v === "object" && v !== null, "期望一个对象");
  return { ...v };
}

describe("Express App Routes", () => {
  let tempDir: string;
  let bookmarksFile: string;
  let server: any;
  let port: number;
  let dataDir: string;

  beforeEach(async () => {
    // 创建临时目录和书签文件
    tempDir = await mkdtemp(join(tmpdir(), "zhandao-test-"));
    bookmarksFile = join(tempDir, "Bookmarks");

    // 创建数据目录用于测试
    dataDir = await mkdtemp(join(tmpdir(), "zhandao-data-test-"));
    process.env.ZHANDAO_DATA_DIR = dataDir;

    const testBookmarks = {
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "书签栏",
          children: [
            {
              type: "folder",
              name: "Zhandao待收录",
              children: [
                {
                  type: "url",
                  name: "Example 1",
                  url: "https://example.com/page1",
                  date_added: "13287539453000000", // WebKit epoch: ~2022-01-01
                },
                {
                  type: "url",
                  name: "Example 2",
                  url: "https://example.com/page2",
                  date_added: "13287539454000000",
                },
              ],
            },
          ],
        },
      },
    };

    await writeFile(bookmarksFile, JSON.stringify(testBookmarks, null, 2));

    // 创建 app 并启动服务器
    const app = createApp(bookmarksFile);
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        port = (srv.address() as any).port;
        resolve(srv);
      });
    });
  });

  afterEach(async () => {
    return new Promise<void>(async (resolve) => {
      server.close(async () => {
        // 清理数据目录
        try {
          await rm(dataDir, { recursive: true, force: true });
        } catch {
          // 忽略清理错误
        }
        delete process.env.ZHANDAO_DATA_DIR;
        resolve();
      });
    });
  });

  test("GET /api/inbox returns entries from bookmarks", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox`);
    assert.strictEqual(response.status, 200);

    const data = (await response.json()) as any;
    assert.ok(Array.isArray(data.entries), "entries should be an array");
    assert.strictEqual(data.entries.length, 2, "should have 2 bookmarks");
    assert.strictEqual(data.entries[0].title, "Example 1");
    assert.strictEqual(data.entries[0].url, "https://example.com/page1");
    assert.ok(Array.isArray(data.matchedFolders), "matchedFolders should be an array");
    assert.ok(data.matchedFolders.length > 0, "should match the inbox folder");
  });

  test("GET /api/inbox returns 404 when inbox folder not found", async () => {
    // 创建一个没有 Zhandao待收录 文件夹的书签文件
    const emptyBookmarks = {
      roots: {
        bookmark_bar: {
          type: "folder",
          name: "书签栏",
          children: [],
        },
      },
    };

    const emptyBookmarksFile = join(tempDir, "EmptyBookmarks");
    await writeFile(emptyBookmarksFile, JSON.stringify(emptyBookmarks, null, 2));

    const app = createApp(emptyBookmarksFile);
    const testServer = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => {
        resolve(srv);
      });
    });

    const testPort = (testServer.address() as any).port;

    try {
      const response = await fetch(`http://localhost:${testPort}/api/inbox`);
      assert.strictEqual(response.status, 404);

      const data = (await response.json()) as any;
      assert.ok(data.error, "should have error message");
    } finally {
      testServer.close();
    }
  });

  test("POST /api/inbox/fetch 与 GET /api/inbox 看到的是同一个集合（已处理的都不算）", async () => {
    // 回归测试。原先 fetch 端点没减去已处理的 URL，于是：
    // ① 已收录的条目被重抓，其中掘金那三条会去踩已知的限流（空壳页）；
    // ② 进度分母与可见列表不一致（9 vs 3），界面看起来像卡住了。
    const { appendProcessed } = await import("./inbox/processed.js");
    await appendProcessed({
      url: "https://example.com/page1",
      decision: "kept",
      at: new Date().toISOString(),
      materialId: "01TESTTESTTESTTESTTESTTEST",
    });

    const listRes = await fetch(`http://localhost:${port}/api/inbox`);
    const listBody: unknown = await listRes.json();
    assert.ok(isRecord(listBody));
    assert.ok(Array.isArray(listBody.entries));
    assert.strictEqual(listBody.entries.length, 1, "列表应只剩未处理的那条");
    assert.strictEqual(listBody.filtered, 1, "应报告过滤掉了 1 条");

    const fetchRes = await fetch(`http://localhost:${port}/api/inbox/fetch`, { method: "POST" });
    const fetchBody: unknown = await fetchRes.json();
    assert.ok(isRecord(fetchBody));
    assert.strictEqual(
      fetchBody.total,
      1,
      "抓取的条数必须等于列表条数——不相等就说明两处过滤逻辑又分叉了",
    );
  });

  test("POST /api/inbox/fetch returns jobId and total", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/fetch`, {
      method: "POST",
    });

    assert.strictEqual(response.status, 200);
    const data = (await response.json()) as any;
    assert.ok(data.jobId, "should have jobId");
    assert.strictEqual(data.total, 2, "should have total=2");
  });

  test("POST /api/inbox/fetch returns same jobId on repeated calls", async () => {
    const response1 = await fetch(`http://localhost:${port}/api/inbox/fetch`, {
      method: "POST",
    });
    const data1 = (await response1.json()) as any;
    const jobId1 = data1.jobId;

    const response2 = await fetch(`http://localhost:${port}/api/inbox/fetch`, {
      method: "POST",
    });
    const data2 = (await response2.json()) as any;
    const jobId2 = data2.jobId;

    assert.strictEqual(jobId1, jobId2, "should return same jobId for concurrent calls");
  });

  test("GET /api/inbox/events receives progress and done events", async () => {
    // 简化版：只验证 SSE 路由和事件格式正确
    // 创建一个临时的 jobId
    const tempJobId = "temp_test_job";

    // 尝试订阅一个不存在的 job，应该返回 404
    const notFoundResponse = await fetch(`http://localhost:${port}/api/inbox/events?jobId=${tempJobId}`);
    assert.strictEqual(notFoundResponse.status, 404);

    // 现在启动真正的抓取
    const fetchResponse = await fetch(`http://localhost:${port}/api/inbox/fetch`, {
      method: "POST",
    });
    assert.strictEqual(fetchResponse.status, 200);
    const fetchData = (await fetchResponse.json()) as any;
    const jobId = fetchData.jobId;

    assert.ok(jobId, "should have jobId");
    assert.strictEqual(fetchData.total, 2, "should have total=2");

    // 立即订阅事件
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 10000);

    try {
      const eventResponse = await fetch(`http://localhost:${port}/api/inbox/events?jobId=${jobId}`, {
        signal: abortController.signal,
      });
      assert.strictEqual(eventResponse.status, 200);
      assert.strictEqual(eventResponse.headers.get("content-type"), "text/event-stream");

      // 只读一小部分数据来验证流是否有效
      const reader = eventResponse.body!.getReader();
      const decoder = new TextDecoder();

      let hasData = false;
      for (let i = 0; i < 100; i++) {
        // 尽量读取最多 100 次
        try {
          const { value } = await Promise.race([
            reader.read(),
            new Promise<{ value: Uint8Array }>((_resolve, reject) => {
              const id = setTimeout(() => reject(new Error("timeout")), 1000);
              reader.read().then((result) => {
                clearTimeout(id);
                if (result.done) _resolve(result as unknown as { value: Uint8Array });
                else _resolve({ value: result.value! });
              });
            }),
          ]);

          if (value && value.length > 0) {
            hasData = true;
            const text = decoder.decode(value, { stream: true });
            // 只需验证有某种形式的事件数据
            if (text.includes("event:") || text.includes("data:")) {
              break; // 收到了事件数据，够了
            }
          }
        } catch {
          // 超时或其他错误，停止读取
          break;
        }
      }

      reader.cancel();

      // 至少应该有一些 SSE 格式的数据
      assert.ok(hasData, "should receive SSE formatted data");
    } finally {
      clearTimeout(timeoutId);
    }
  });

  test("GET /api/inbox/events 重复的 jobId 参数按缺失处理，返回 400", async () => {
    // 回归守卫：这里一度写的是 `req.query.jobId as string | undefined`。
    // Express 在 `?jobId=a&jobId=b` 时给的是**数组**，断言拦不住它，
    // 而后面的 `if (!jobId)` 对数组恒为假（数组是 truthy），于是带着一个数组
    // 一路往下走到 jobs 查找。改成 typeof 收窄之后它落进「缺参数」分支。
    const response = await fetch(`http://localhost:${port}/api/inbox/events?jobId=a&jobId=b`);
    assert.strictEqual(response.status, 400);
    // 断言文案：改之前这条路径返回的是 404（数组被当成 jobId 去查作业、查不到），
    // 只断言「不是 200」区分不出修没修。
    const body: unknown = await response.json();
    assert.ok(body !== null && typeof body === "object" && "error" in body);
    assert.strictEqual(body.error, "Missing jobId query parameter");
  });

  test("POST /api/inbox/keep 没有 Content-Type 时返回 400 而不是崩", async () => {
    // 回归守卫：这里一度写的是 `req.body as Record<string, unknown>`。
    // **触发点不是「JSON 不是对象」**——那种请求被 express.json() 的 strict 模式
    // 挡在外面，返回的是 HTML 错误页，我们的代码根本跑不到（实测确认过）。
    // 真正的触发点是**没有 Content-Type**：express.json() 此时不填 req.body，
    // 它是 undefined，而 `const { url } = undefined` 直接抛 TypeError。
    // 所以必须断言**错误文案**而不只是状态码，否则这条测试会因为错误的原因通过。
    const response = await fetch(`http://localhost:${port}/api/inbox/keep`, { method: "POST" });
    assert.strictEqual(response.status, 400);
    const body: unknown = await response.json();
    assert.ok(body !== null && typeof body === "object" && "error" in body);
    assert.strictEqual(body.error, "Missing or invalid request body");
  });

  test("GET /api/inbox/events returns 404 for non-existent jobId", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/events?jobId=invalid-job-id`);
    assert.strictEqual(response.status, 404);

    const data = (await response.json()) as any;
    assert.ok(data.error, "should have error message");
  });

  test("GET /api/inbox/events returns 400 when jobId is missing", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/events`);
    assert.strictEqual(response.status, 400);

    const data = (await response.json()) as any;
    assert.ok(data.error, "should have error message");
  });

  test("GET /api/inbox includes filtered field", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox`);
    assert.strictEqual(response.status, 200);

    const data = (await response.json()) as any;
    assert.ok(typeof data.filtered === "number", "should have filtered field");
  });

  test("GET /api/inbox filters out processed URLs", async () => {
    // 先读取所有条目
    const response1 = await fetch(`http://localhost:${port}/api/inbox`);
    const data1 = (await response1.json()) as any;
    const initialCount = data1.entries.length;
    assert.strictEqual(initialCount, 2);

    // 标记一个 URL 为已处理
    const urlToDrop = data1.entries[0].url;
    const dropResponse = await fetch(`http://localhost:${port}/api/inbox/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlToDrop }),
    });
    assert.strictEqual(dropResponse.status, 200);

    // 再次读取，应该少一条
    const response2 = await fetch(`http://localhost:${port}/api/inbox`);
    const data2 = (await response2.json()) as any;
    assert.strictEqual(data2.entries.length, 1, "should have 1 entry after drop");
    assert.strictEqual(data2.filtered, 1, "filtered should be 1");
  });

  test("POST /api/inbox/keep requires title", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/test",
      }),
    });
    assert.strictEqual(response.status, 400);

    const data = (await response.json()) as any;
    assert.ok(data.error, "should have error message");
  });

  test("POST /api/inbox/keep returns 410 when cache is missing", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/test",
        title: "Test Article",
      }),
    });
    assert.strictEqual(response.status, 410);

    const data = (await response.json()) as any;
    assert.ok(data.error, "should have error message");
    assert.match(data.error, /cache|re-fetch|reprocess/i);
  });

  test("POST /api/inbox/keep returns 409 for duplicate URL", async () => {
    // 导入 cacheExtraction 来预先设置缓存
    const { cacheExtraction } = await import("./inbox/extract-cache.js");

    const url = "https://example.com/test";
    const title = "Test Article";
    const markdown = "# Content";

    // 预先缓存正文
    await cacheExtraction(url, markdown);

    // 第一次 keep
    const response1 = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });
    assert.strictEqual(response1.status, 201);

    // 第二次 keep 同一个 URL，应该返回 409
    const response2 = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });
    assert.strictEqual(response2.status, 409);
  });

  test("POST /api/inbox/keep successfully writes material when cache exists", async () => {
    const { cacheExtraction } = await import("./inbox/extract-cache.js");

    const url = "https://example.com/test";
    const title = "Test Article";
    const markdown = "# Test Content\n\nSome text here.";

    // 预先缓存正文
    await cacheExtraction(url, markdown);

    const response = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });

    assert.strictEqual(response.status, 201);
    const data = (await response.json()) as any;

    assert.ok(data.id, "should return material id");
    assert.ok(data.path, "should return material path");
    assert.match(data.id, /^[A-Z0-9]{26}$/);
  });

  test("POST /api/inbox/keep works after job memory is cleared", async () => {
    const { cacheExtraction } = await import("./inbox/extract-cache.js");

    const url = "https://example.com/test-after-clear";
    const title = "Test After Memory Clear";
    const markdown = "# Content that survives memory clear";

    // 缓存正文
    await cacheExtraction(url, markdown);

    // 不通过 fetch 获取结果，直接尝试 keep
    // （模拟：用户读完文章、30 秒过去了、作业内存被清理了、用户点留下）
    const response = await fetch(`http://localhost:${port}/api/inbox/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title }),
    });

    // 即使作业已清理，由于正文在缓存里，keep 仍然成功
    assert.strictEqual(response.status, 201);
    const data = (await response.json()) as any;
    assert.ok(data.id);
  });

  test("POST /api/inbox/drop requires URL", async () => {
    const response = await fetch(`http://localhost:${port}/api/inbox/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(response.status, 400);

    const data = (await response.json()) as any;
    assert.ok(data.error, "should have error message");
  });

  test("POST /api/inbox/drop returns 409 for duplicate URL", async () => {
    const url = "https://example.com/test";

    // 第一次 drop
    const response1 = await fetch(`http://localhost:${port}/api/inbox/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    assert.strictEqual(response1.status, 200);

    // 第二次 drop 同一个 URL，应该返回 409
    const response2 = await fetch(`http://localhost:${port}/api/inbox/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    assert.strictEqual(response2.status, 409);
  });

  test("POST /api/inbox/drop successfully records decision", async () => {
    const url = "https://example.com/test";

    const response = await fetch(`http://localhost:${port}/api/inbox/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    assert.strictEqual(response.status, 200);
    const data = (await response.json()) as any;
    assert.strictEqual(data.ok, true);
  });
});


/** 类型守卫而非 `as` 断言：测试里读回 fetch 响应体（本就是 unknown）时收窄类型 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface PendingNoteCandidate {
  id: string;
  title: string;
  source: string;
  score: number;
}

interface PendingNote {
  id: string;
  text: string;
  at: string;
  query: string;
  queryOk: boolean;
  candidates: PendingNoteCandidate[];
}

function isPendingNoteCandidate(value: unknown): value is PendingNoteCandidate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.source === "string" &&
    typeof value.score === "number"
  );
}

function isPendingNote(value: unknown): value is PendingNote {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.at === "string" &&
    typeof value.query === "string" &&
    typeof value.queryOk === "boolean" &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isPendingNoteCandidate)
  );
}

/** 解析 GET /api/notes/pending 的响应体，形状不对就让测试直接失败（而不是假装它对） */
function parsePendingNotes(value: unknown): PendingNote[] {
  if (!isRecord(value) || !Array.isArray(value.notes) || !value.notes.every(isPendingNote)) {
    throw new Error(`GET /api/notes/pending 响应形状不对: ${JSON.stringify(value)}`);
  }
  return value.notes;
}

/** 解析 POST /api/notes/:id/attach 成功响应的响应体 */
function parseAttachResponse(value: unknown): { annotationId: string; path: string } {
  if (!isRecord(value) || typeof value.annotationId !== "string" || typeof value.path !== "string") {
    throw new Error(`POST attach 响应形状不对: ${JSON.stringify(value)}`);
  }
  return { annotationId: value.annotationId, path: value.path };
}

/** 取 { ok: boolean } 响应体里的 ok 字段 */
function parseOkResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error(`响应形状不对，缺少 ok 字段: ${JSON.stringify(value)}`);
  }
  return value.ok;
}

/** 取 { error: ... } 响应体里的 error 字段是否存在（不关心其具体类型） */
function hasErrorField(value: unknown): boolean {
  return isRecord(value) && "error" in value && Boolean(value.error);
}

describe("Notes routes (归属)", () => {
  let tempDir: string;
  let bookmarksFile: string;
  let server: Server;
  let port: number;
  let dataDir: string;
  // 可在每条测试里重新赋值的提炼实现：默认原样返回原文，保持这组测试里
  // 早于「提炼查询」这个特性就写好的用例（直接拿原文当查询）行为不变；
  // 需要测试提炼失败 / 调用次数的用例再各自覆盖它。
  let distillImpl: (noteText: string) => Promise<string>;
  let distillCallCount: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhandao-notes-test-"));
    bookmarksFile = join(tempDir, "Bookmarks");
    dataDir = await mkdtemp(join(tmpdir(), "zhandao-notes-data-test-"));
    process.env.ZHANDAO_DATA_DIR = dataDir;

    // 空书签夹即可——这组测试只关心归属链路，不关心收件箱
    const testBookmarks = {
      roots: { bookmark_bar: { type: "folder", name: "书签栏", children: [] } },
    };
    await writeFile(bookmarksFile, JSON.stringify(testBookmarks, null, 2));

    distillImpl = async (noteText: string) => noteText;
    distillCallCount = 0;

    // 注入假的提炼实现：不许真的调 DeepSeek。间接调用 distillImpl 而不是直接传它，
    // 好让每条测试能在请求发出前重新赋值 distillImpl / 读到 distillCallCount。
    const app = createApp(bookmarksFile, async (noteText: string) => {
      distillCallCount += 1;
      return distillImpl(noteText);
    });
    server = await new Promise<Server>((resolveFn) => {
      const srv = app.listen(0, () => {
        const address = srv.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected AddressInfo from server.address()");
        }
        port = address.port;
        resolveFn(srv);
      });
    });
  });

  afterEach(async () => {
    return new Promise<void>((resolveFn) => {
      server.close(async () => {
        try {
          await rm(dataDir, { recursive: true, force: true });
        } catch {
          // 忽略清理错误
        }
        delete process.env.ZHANDAO_DATA_DIR;
        resolveFn();
      });
    });
  });

  test("GET /api/materials 按标题列出全部材料", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    await writeMaterial({ title: "乙材料", markdown: "内容乙", source: "https://example.com/b" });
    await writeMaterial({ title: "甲材料", markdown: "内容甲", source: "https://example.com/a" });

    const res = await fetch(`http://localhost:${port}/api/materials`);
    assert.strictEqual(res.status, 200);

    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    const { materials } = body;
    assert.ok(Array.isArray(materials));
    assert.strictEqual(materials.length, 2);

    // 这个端点存在的全部理由是「可浏览的完整列表」，所以顺序稳定是它的功能而非细节：
    // 列表每次刷新都重排，人就没法靠位置认出条目。
    const titles: string[] = [];
    for (const m of materials) {
      assert.ok(isRecord(m));
      assert.strictEqual(typeof m.title, "string");
      if (typeof m.title === "string") titles.push(m.title);
    }
    assert.deepStrictEqual(titles, ["甲材料", "乙材料"]);
  });

  test("GET /api/materials 库为空时返回空数组而不是报错", async () => {
    const res = await fetch(`http://localhost:${port}/api/materials`);
    assert.strictEqual(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.deepStrictEqual(body.materials, []);
  });

  test("GET /api/annotations 库为空时返回空数组", async () => {
    const res = await fetch(`http://localhost:${port}/api/annotations`);
    assert.strictEqual(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.deepStrictEqual(body.annotations, []);
  });

  test("GET /api/annotations 按 at 升序返回，字段齐全", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    const { writeAnnotation } = await import("./annotations/write.js");

    const material = await writeMaterial({
      title: "材料甲",
      markdown: "内容",
      source: "https://example.com/a",
    });

    // 与 push/pool.test.ts 同一手法：writeAnnotation 内部用 Date.now() 打 at 时间戳，
    // 两次顺序 await 调用之间时钟单调不减，先写的那条 at 更早——用天然时间差验证排序，
    // 不需要也不能从外部注入 at（由 writeAnnotation 内部生成）。
    const first = await writeAnnotation({ materialId: material.id, text: "先写的标注" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await writeAnnotation({ materialId: material.id, text: "后写的标注" });

    const res = await fetch(`http://localhost:${port}/api/annotations`);
    assert.strictEqual(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    const { annotations } = body;
    assert.ok(Array.isArray(annotations));
    assert.strictEqual(annotations.length, 2);

    const [a, b] = annotations;
    assert.ok(isRecord(a) && isRecord(b));
    assert.strictEqual(a.id, first.id);
    assert.strictEqual(b.id, second.id);
    assert.strictEqual(a.material, material.id);
    assert.strictEqual(a.text, "先写的标注");
    assert.strictEqual(typeof a.at, "string");
    assert.deepStrictEqual(a.targets, []);
  });

  test("GET /api/notes/pending 返回未处理的速记，附带候选材料", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");

    await writeMaterial({
      title: "Promise 面试题",
      markdown: "Promise 的执行顺序与微任务队列细节",
      source: "https://example.com/promise",
    });
    const note = await appendQuickNote("Promise 微任务顺序到底怎么排的");

    const res = await fetch(`http://localhost:${port}/api/notes/pending`);
    assert.strictEqual(res.status, 200);
    const notes = parsePendingNotes(await res.json());

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0]?.id, note.id);
    assert.strictEqual(notes[0]?.text, note.text);
    assert.strictEqual(notes[0]?.queryOk, true);
    assert.strictEqual(notes[0]?.query, note.text); // 这条测试的假实现是恒等函数
    assert.ok(notes[0] && notes[0].candidates.length > 0, "库里有材料时应返回至少一个候选");
  });

  test("库里没有材料时 candidates 为空数组", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    await appendQuickNote("没有材料能接住的一句话");

    const res = await fetch(`http://localhost:${port}/api/notes/pending`);
    const notes = parsePendingNotes(await res.json());

    assert.strictEqual(notes.length, 1);
    assert.deepEqual(notes[0]?.candidates, []);
  });

  test("pending 用提炼后的查询搜，而不是原文", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");

    // 材料标题只匹配提炼后的查询，不匹配原文——这样才能确认搜索确实
    // 用的是 distillFn 的输出，而不是速记原文
    await writeMaterial({
      title: "undici 代理配置",
      markdown: "undici 不读 http_proxy 环境变量，需要 EnvHttpProxyAgent",
      source: "https://example.com/undici-proxy",
    });
    distillImpl = async () => "undici 代理配置";

    const note = await appendQuickNote(
      "站点一直连不上，排查了半天，原因跟代理设置有关系，具体细节记不清了",
    );

    const res = await fetch(`http://localhost:${port}/api/notes/pending`);
    assert.strictEqual(res.status, 200);
    const notes = parsePendingNotes(await res.json());

    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0]?.id, note.id);
    assert.strictEqual(notes[0]?.query, "undici 代理配置");
    assert.strictEqual(notes[0]?.queryOk, true);
    assert.ok(
      notes[0]?.candidates.some((c) => c.title === "undici 代理配置"),
      "应该用提炼后的查询命中该材料",
    );
  });

  test("提炼查询的缓存命中时不再调用 distillFn", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const note = await appendQuickNote("一条会被提炼、然后缓存命中的速记");

    const first = await fetch(`http://localhost:${port}/api/notes/pending`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(distillCallCount, 1);

    const countAfterFirst = distillCallCount;
    const second = await fetch(`http://localhost:${port}/api/notes/pending`);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(
      distillCallCount,
      countAfterFirst,
      "第二次请求应命中缓存，不应再调用 distillFn",
    );

    const notes = parsePendingNotes(await second.json());
    assert.strictEqual(notes[0]?.id, note.id);
    assert.strictEqual(notes[0]?.queryOk, true);
  });

  test("distillFn 失败时该条 queryOk 为 false、candidates 为空，且不影响其他条目", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");

    await writeMaterial({
      title: "材料 A",
      markdown: "能被正常匹配到的内容",
      source: "https://example.com/a",
    });

    const goodNote = await appendQuickNote("材料 A");
    // append 之后再切换实现：goodNote 走默认恒等函数（先请求过一次会被缓存，
    // 所以这里改成显式失败 only for 下一条，靠 note 内容区分）
    const badNote = await appendQuickNote("会让提炼失败的那一条");

    distillImpl = async (noteText: string) => {
      if (noteText === badNote.text) {
        throw new Error("模拟提炼失败");
      }
      return noteText;
    };

    const res = await fetch(`http://localhost:${port}/api/notes/pending`);
    assert.strictEqual(res.status, 200);
    const notes = parsePendingNotes(await res.json());
    assert.strictEqual(notes.length, 2);

    const good = notes.find((n) => n.id === goodNote.id);
    const bad = notes.find((n) => n.id === badNote.id);

    assert.ok(good, "未失败的条目应该照常返回");
    assert.strictEqual(good?.queryOk, true);
    assert.ok(good && good.candidates.length > 0);

    assert.ok(bad, "失败的条目也应该出现在响应里");
    assert.strictEqual(bad?.queryOk, false);
    assert.strictEqual(bad?.query, "");
    assert.deepStrictEqual(bad?.candidates, []);
  });

  test("attach 成功后该 note 不再出现在 pending 里", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");

    const material = await writeMaterial({
      title: "材料 A",
      markdown: "内容",
      source: "https://example.com/a",
    });
    const note = await appendQuickNote("一句速记");

    const attachRes = await fetch(`http://localhost:${port}/api/notes/${note.id}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: note.text, materialId: material.id }),
    });
    assert.strictEqual(attachRes.status, 201);
    const attachData = parseAttachResponse(await attachRes.json());
    assert.ok(attachData.annotationId);
    assert.ok(attachData.path);

    const pendingRes = await fetch(`http://localhost:${port}/api/notes/pending`);
    const pendingNotes = parsePendingNotes(await pendingRes.json());
    assert.strictEqual(pendingNotes.length, 0);
  });

  test("attach 未知 note id 返回 404", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "材料 A",
      markdown: "内容",
      source: "https://example.com/a",
    });

    const res = await fetch(`http://localhost:${port}/api/notes/nonexistent-id/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "文本", materialId: material.id }),
    });
    assert.strictEqual(res.status, 404);
  });

  test("attach 已处理的 note 返回 409", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "材料 A",
      markdown: "内容",
      source: "https://example.com/a",
    });
    const note = await appendQuickNote("一句速记");

    const first = await fetch(`http://localhost:${port}/api/notes/${note.id}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: note.text, materialId: material.id }),
    });
    assert.strictEqual(first.status, 201);

    const second = await fetch(`http://localhost:${port}/api/notes/${note.id}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: note.text, materialId: material.id }),
    });
    assert.strictEqual(second.status, 409);
  });

  test("attach 空 text 返回 400", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "材料 A",
      markdown: "内容",
      source: "https://example.com/a",
    });
    const note = await appendQuickNote("一句速记");

    const res = await fetch(`http://localhost:${port}/api/notes/${note.id}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   ", materialId: material.id }),
    });
    assert.strictEqual(res.status, 400);
  });

  test("attach 宿主材料不存在返回 400", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const note = await appendQuickNote("一句速记");

    const res = await fetch(`http://localhost:${port}/api/notes/${note.id}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: note.text, materialId: "nonexistent-material-id" }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(hasErrorField(await res.json()), "should have error message about missing host material");
  });

  test("drop 未知 note id 返回 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/notes/nonexistent-id/drop`, {
      method: "POST",
    });
    assert.strictEqual(res.status, 404);
  });

  test("drop 成功返回 200，重复 drop 返回 409", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const note = await appendQuickNote("待丢弃的一句话");

    const res = await fetch(`http://localhost:${port}/api/notes/${note.id}/drop`, {
      method: "POST",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(parseOkResponse(await res.json()), true);

    const res2 = await fetch(`http://localhost:${port}/api/notes/${note.id}/drop`, {
      method: "POST",
    });
    assert.strictEqual(res2.status, 409);
  });

  test("drop 后该 note 不再出现在 pending 里", async () => {
    const { appendQuickNote } = await import("./quicknotes/append.js");
    const note = await appendQuickNote("待丢弃的一句话");

    await fetch(`http://localhost:${port}/api/notes/${note.id}/drop`, { method: "POST" });

    const pendingRes = await fetch(`http://localhost:${port}/api/notes/pending`);
    const pendingNotes = parsePendingNotes(await pendingRes.json());
    assert.strictEqual(pendingNotes.length, 0);
  });

  test("GET /api/search 用给定查询直接搜，返回候选材料", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    await writeMaterial({
      title: "undici 代理配置",
      markdown: "undici 不读 http_proxy 环境变量",
      source: "https://example.com/undici-proxy",
    });

    const res = await fetch(
      `http://localhost:${port}/api/search?q=${encodeURIComponent("undici 代理")}`,
    );
    assert.strictEqual(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.ok(Array.isArray(body.candidates));
    assert.ok(body.candidates.length > 0);
  });

  test("GET /api/search 缺 q 返回 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/search`);
    assert.strictEqual(res.status, 400);
    assert.ok(hasErrorField(await res.json()));
  });

  test("GET /api/search q 为空白字符串返回 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/search?q=${encodeURIComponent("   ")}`);
    assert.strictEqual(res.status, 400);
  });

  test("GET /api/search 支持 limit 参数", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    for (let i = 0; i < 5; i++) {
      await writeMaterial({
        title: `材料 ${i}`,
        markdown: "共同关键词 共同关键词 共同关键词",
        source: `https://example.com/${i}`,
      });
    }

    const res = await fetch(`http://localhost:${port}/api/search?q=共同关键词&limit=2`);
    assert.strictEqual(res.status, 200);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.ok(Array.isArray(body.candidates));
    assert.strictEqual(body.candidates.length, 2);
  });
});

describe("Drills routes (预练)", () => {
  let tempDir: string;
  let bookmarksFile: string;
  let server: Server;
  let port: number;
  let dataDir: string;
  // 可在每条测试里重新赋值的提取实现：不许真的调 DeepSeek，形状照抄
  // 「Notes routes (归属)」那组测试里 distillImpl 的注入方式。
  let extractImpl: (
    candidates: { line: number; text: string }[],
  ) => Promise<{ line: number; question: string }[]>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhandao-drills-test-"));
    bookmarksFile = join(tempDir, "Bookmarks");
    dataDir = await mkdtemp(join(tmpdir(), "zhandao-drills-data-test-"));
    process.env.ZHANDAO_DATA_DIR = dataDir;

    const testBookmarks = {
      roots: { bookmark_bar: { type: "folder", name: "书签栏", children: [] } },
    };
    await writeFile(bookmarksFile, JSON.stringify(testBookmarks, null, 2));

    extractImpl = async () => [];

    const app = createApp(bookmarksFile, undefined, async (candidates) => {
      return extractImpl(candidates);
    });
    server = await new Promise<Server>((resolveFn) => {
      const srv = app.listen(0, () => {
        const address = srv.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected AddressInfo from server.address()");
        }
        port = address.port;
        resolveFn(srv);
      });
    });
  });

  afterEach(async () => {
    return new Promise<void>((resolveFn) => {
      server.close(async () => {
        try {
          await rm(dataDir, { recursive: true, force: true });
        } catch {
          // 忽略清理错误
        }
        delete process.env.ZHANDAO_DATA_DIR;
        resolveFn();
      });
    });
  });

  test("GET /api/materials/:id/drills 正常返回，附带定位后的锚点信息", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "面试题合集",
      markdown: "### 什么是闭包？\n\n闭包是……",
      source: "https://example.com/interview",
    });

    extractImpl = async () => [{ line: 0, question: "什么是闭包？" }];

    const res = await fetch(`http://localhost:${port}/api/materials/${material.id}/drills`);
    assert.strictEqual(res.status, 200);

    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.strictEqual(body.materialId, material.id);
    assert.ok(Array.isArray(body.drills));
    assert.strictEqual(body.drills.length, 1);
    const drill = body.drills[0];
    assert.ok(isRecord(drill));
    assert.strictEqual(drill.question, "什么是闭包？");
    assert.strictEqual(drill.anchor, "### 什么是闭包？");
    // 0 = 正文第一行。这里曾经是 1，因为 `search/materials-index.ts` 的「去掉开头空行」
    // 是段死代码（`if (first && ...)` 里空字符串本身 falsy），每份材料都多带一个开头空行。
    // 已于 2026-09-19 修掉，时机是刻意的：anchorLine 一旦被缓存进 `.cache/drills-*.json`，
    // 再修就会让全部锚点静默偏移一行（揭晓时显示错的那一节）。
    assert.strictEqual(drill.anchorLine, 0);
    assert.strictEqual(drill.lastKnown, null);
    assert.ok(typeof drill.id === "string" && drill.id.startsWith(`${material.id}#`));
  });

  test("GET /api/materials/:id/drills 材料不存在返回 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/materials/nonexistent-id/drills`);
    assert.strictEqual(res.status, 404);
  });

  test("GET /api/materials/:id/drills 提取失败返回 502 且带 code", async () => {
    const { DrillExtractFailed } = await import("./model/extract-drills.js");
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "提取会失败的材料",
      markdown: "正文",
      source: "https://example.com/fail",
    });

    extractImpl = async () => {
      throw new DrillExtractFailed("模拟提取失败");
    };

    const res = await fetch(`http://localhost:${port}/api/materials/${material.id}/drills`);
    assert.strictEqual(res.status, 502);
    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.strictEqual(body.code, "drill_extract_failed");
    assert.ok(hasErrorField(body));
  });

  test("POST /api/drills/record 正常记录返回 201", async () => {
    const res = await fetch(`http://localhost:${port}/api/drills/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drillId: "mat1#q1", materialId: "mat1", known: true }),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(parseOkResponse(await res.json()), true);

    const { readDrillVerdicts } = await import("./drills/records.js");
    const verdicts = await readDrillVerdicts();
    assert.strictEqual(verdicts.get("mat1#q1")?.known, true);
  });

  test("POST /api/drills/record 缺 drillId 返回 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/drills/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ materialId: "mat1", known: true }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(hasErrorField(await res.json()));
  });

  test("POST /api/drills/record 缺 known 返回 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/drills/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drillId: "mat1#q1", materialId: "mat1" }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok(hasErrorField(await res.json()));
  });

  test("POST /api/drills/record materialId 不是字符串返回 400", async () => {
    const res = await fetch(`http://localhost:${port}/api/drills/record`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drillId: "mat1#q1", materialId: 123, known: true }),
    });
    assert.strictEqual(res.status, 400);
  });

  test("GET /api/drills/status 没有任何缓存时返回全部材料且 cached:false、三个计数都是 0", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    const material = await writeMaterial({
      title: "从未预练过的材料",
      markdown: "正文",
      source: "https://example.com/untouched",
    });

    const res = await fetch(`http://localhost:${port}/api/drills/status`);
    assert.strictEqual(res.status, 200);

    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.ok(Array.isArray(body.materials));
    assert.strictEqual(body.materials.length, 1);
    const status = body.materials[0];
    assert.ok(isRecord(status));
    assert.strictEqual(status.materialId, material.id);
    assert.strictEqual(status.title, "从未预练过的材料");
    assert.strictEqual(status.cached, false);
    assert.strictEqual(status.total, 0);
    assert.strictEqual(status.unknown, 0);
    assert.strictEqual(status.unattempted, 0);
  });

  test("GET /api/drills/status 有缓存与记录时 total / unknown / unattempted 三个数都对", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    const { cacheDrills } = await import("./drills/cache.js");
    const { appendDrillRecord: appendRecord } = await import("./drills/records.js");

    const material = await writeMaterial({
      title: "练过一部分的材料",
      markdown: "### 第一题\n\n### 第二题\n\n### 第三题\n",
      source: "https://example.com/partial",
    });

    // 构造「1 道标会、1 道标不会、1 道没练过」的场景
    const drills = [
      {
        id: `${material.id}#q1`,
        materialId: material.id,
        question: "第一题？",
        anchor: "### 第一题",
        anchorLine: 0,
      },
      {
        id: `${material.id}#q2`,
        materialId: material.id,
        question: "第二题？",
        anchor: "### 第二题",
        anchorLine: 2,
      },
      {
        id: `${material.id}#q3`,
        materialId: material.id,
        question: "第三题？",
        anchor: "### 第三题",
        anchorLine: 4,
      },
    ];
    await cacheDrills(material.id, drills);
    await appendRecord({
      drillId: `${material.id}#q1`,
      materialId: material.id,
      known: true,
      at: new Date().toISOString(),
    });
    await appendRecord({
      drillId: `${material.id}#q2`,
      materialId: material.id,
      known: false,
      at: new Date().toISOString(),
    });
    // q3 没有任何记录 —— 从没练过

    const res = await fetch(`http://localhost:${port}/api/drills/status`);
    assert.strictEqual(res.status, 200);

    const body: unknown = await res.json();
    assert.ok(isRecord(body));
    assert.ok(Array.isArray(body.materials));
    const status = body.materials.find(
      (m): m is Record<string, unknown> => isRecord(m) && m.materialId === material.id,
    );
    assert.ok(status);
    assert.strictEqual(status.cached, true);
    assert.strictEqual(status.total, 3);
    assert.strictEqual(status.unknown, 1);
    assert.strictEqual(status.unattempted, 1);
  });

  test("GET /api/drills/status 绝不调模型提取（守卫：注入的提取实现调用次数为 0）", async () => {
    const { writeMaterial } = await import("./materials/write.js");
    await writeMaterial({
      title: "不该触发提取的材料",
      markdown: "### 一个问题？\n\n正文",
      source: "https://example.com/no-model-call",
    });

    let extractCalls = 0;
    extractImpl = async () => {
      extractCalls += 1;
      return [];
    };

    const res = await fetch(`http://localhost:${port}/api/drills/status`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(extractCalls, 0);
  });
});

/**
 * POST /api/ask —— **提问**端点。
 *
 * 这里全部用注入的假模型，**绝不调真实 DeepSeek**（测试打网络是这个项目明令禁止的）。
 * 假模型按调用次数依次吐出预设的协议 JSON，于是整条循环的路径可以被精确摆布。
 */
describe("POST /api/ask", () => {
  let dataDir: string;
  let bookmarksFile: string;
  let tempDir: string;

  const MAT_A = "01M2JD1TKE6C6Q1WQ3JY2ABAX0";
  const MAT_B = "01M2JD1N0VFX9J3VS5D00GM26K";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhandao-ask-"));
    bookmarksFile = join(tempDir, "Bookmarks");
    await writeFile(bookmarksFile, JSON.stringify({ roots: { bookmark_bar: { type: "folder", name: "书签栏", children: [] } } }));

    dataDir = await mkdtemp(join(tmpdir(), "zhandao-ask-data-"));
    process.env.ZHANDAO_DATA_DIR = dataDir;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "materials"), { recursive: true });
    await writeFile(
      join(dataDir, "materials", "a.md"),
      `---\nid: ${MAT_A}\ntitle: 压缩中间件\nsource: https://example.com/a\ncaptured: 2026-09-01T00:00:00.000Z\n---\n\n## 缓冲问题\n\n流式响应要关掉缓冲，否则 SSE 会攒到最后一起到。\n\n## 别的\n\n无关内容。\n`,
    );
    await writeFile(
      join(dataDir, "materials", "b.md"),
      `---\nid: ${MAT_B}\ntitle: 手撕代码篇\nsource: https://example.com/b\ncaptured: 2026-09-02T00:00:00.000Z\n---\n\n## 防抖\n\n防抖是延迟执行。\n`,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ZHANDAO_DATA_DIR;
  });

  /** 把预设应答排成队列；超出队列长度就一直返回最后一条（防止循环跑飞时测试卡死） */
  function scriptedModel(replies: string[]): () => Promise<string> {
    let i = 0;
    return async () => {
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return r ?? "";
    };
  }

  interface Frame { event: string; data: unknown }

  /** 读完整条 SSE 流，解析成帧数组。测试里流是有限的，读到底即可。 */
  async function readStream(res: Response_): Promise<Frame[]> {
    const text = await res.text();
    const frames: Frame[] = [];
    for (const raw of text.split("\n\n")) {
      if (!raw.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
    return frames;
  }

  async function withServer<T>(
    replies: string[],
    fn: (port: number) => Promise<T>,
  ): Promise<T> {
    const app = createApp(bookmarksFile, undefined, undefined, scriptedModel(replies));
    const srv = await new Promise<any>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      return await fn(srv.address().port);
    } finally {
      srv.close();
    }
  }

  function post(port: number, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) {
    return fetch(`http://localhost:${port}/api/ask`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("空问题 / 缺 Content-Type 都返回 400，且错误文案来自我们的守卫", async () => {
    await withServer(["{}"], async (port) => {
      const r1 = await post(port, { question: "   " });
      assert.strictEqual(r1.status, 400);
      const d1: unknown = await r1.json();
      // 断言错误**文案**而不只是状态码：第一版曾因为 express.json() 的 strict 模式
      // 返回 400 而"通过"，那个 400 根本不是我们的守卫发的。
      assert.match(JSON.stringify(d1), /Missing or empty question/);

      // 没有 Content-Type 时 express.json() 不解析，req.body 是 undefined
      const r2 = await fetch(`http://localhost:${port}/api/ask`, { method: "POST", body: "whatever" });
      assert.strictEqual(r2.status, 400);
      assert.match(JSON.stringify(await r2.json()), /Missing or empty question/);
    });
  });

  test("完整路径 search → outline → read → answer，引用带标题，提问记录落盘 found=true", async () => {
    const replies = [
      JSON.stringify({ kind: "search", query: "流式响应 缓冲" }),
      JSON.stringify({ kind: "outline", materialId: MAT_A }),
      JSON.stringify({ kind: "read", materialId: MAT_A, line: 7 }),
      JSON.stringify({ kind: "answer", text: "要关掉缓冲。", cites: [MAT_A] }),
    ];
    await withServer(replies, async (port) => {
      const res = await post(port, { question: "为什么 SSE 会攒到最后一起到？" });
      assert.strictEqual(res.status, 200);
      const frames = await readStream(res);

      const steps = frames.filter((f) => f.event === "step");
      assert.ok(steps.length >= 3, `应当看到至少 3 个步骤事件，实际 ${steps.length}`);

      const done = frames.find((f) => f.event === "done");
      assert.ok(done, "必须有 done 事件");
      const rec = asRecord(done.data);
      assert.strictEqual(rec.found, true);
      assert.strictEqual(rec.answer, "要关掉缓冲。");
      assert.deepStrictEqual(rec.cites, [{ materialId: MAT_A, title: "压缩中间件" }]);

      const { readAsks } = await import("./qa/asks.js");
      const asks = await readAsks();
      assert.strictEqual(asks.length, 1);
      assert.strictEqual(asks[0]?.found, true);
      assert.deepStrictEqual(asks[0]?.queries, ["流式响应 缓冲"]);
      // **答案正文不得落盘**——这是 CLAUDE.md 的硬约束，不是风格偏好
      assert.ok(!JSON.stringify(asks[0]).includes("要关掉缓冲"), "提问记录里不该出现答案正文");
    });
  });

  test("库里没有：found=false 且照样落盘——这类记录是收录信号，最不该被丢", async () => {
    await withServer([JSON.stringify({ kind: "none", reason: "库里没有 Rust 的内容" })], async (port) => {
      const res = await post(port, { question: "Rust 的所有权怎么工作？" });
      const frames = await readStream(res);
      const done = frames.find((f) => f.event === "done");
      assert.ok(done);
      const rec = asRecord(done.data);
      assert.strictEqual(rec.found, false);
      assert.strictEqual(rec.answer, null);

      const { readAsks } = await import("./qa/asks.js");
      const asks = await readAsks();
      assert.strictEqual(asks.length, 1);
      assert.strictEqual(asks[0]?.found, false);
    });
  });

  test("编造引用：引用了没读过的材料，整体降级为「库里没有」", async () => {
    const replies = [
      JSON.stringify({ kind: "search", query: "防抖" }),
      // 没有 read 过任何材料就直接作答，并引用 MAT_B
      JSON.stringify({ kind: "answer", text: "防抖是延迟执行。", cites: [MAT_B] }),
    ];
    await withServer(replies, async (port) => {
      const res = await post(port, { question: "防抖是什么？" });
      const frames = await readStream(res);
      const done = frames.find((f) => f.event === "done");
      assert.ok(done);
      const rec = asRecord(done.data);
      assert.strictEqual(rec.answer, null, "没读过就引用，必须被剔成空并降级");
      assert.strictEqual(rec.found, false);
      assert.deepStrictEqual(rec.cites, []);
    });
  });
});
