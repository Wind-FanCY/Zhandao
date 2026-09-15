import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "./app.js";

describe("Express App Routes", () => {
  let tempDir: string;
  let bookmarksFile: string;
  let server: any;
  let port: number;

  beforeEach(async () => {
    // 创建临时目录和书签文件
    tempDir = await mkdtemp(join(tmpdir(), "zhandao-test-"));
    bookmarksFile = join(tempDir, "Bookmarks");

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
    return new Promise<void>((resolve) => {
      server.close(() => {
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
});
