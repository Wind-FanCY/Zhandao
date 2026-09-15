import { useState, useEffect, useRef } from "react";

interface InboxEntry {
  title: string;
  url: string;
  folderPath: string;
  addedAt: string | null;
}

/**
 * SSE 的 item 事件载荷中的成功结果。
 * 注意：这不是服务端的 ExtractSuccess，而是裁剪后的 wire 格式（markdown 只传前 300 字）。
 */
interface WireSuccess {
  ok: true;
  title: string;
  textLength: number;
  finalUrl: string;
  markdown: string;
}

/**
 * SSE 的 item 事件载荷中的失败结果。
 */
interface WireFailure {
  ok: false;
  reason: "not_html" | "http_error" | "network" | "timeout" | "no_content" | "too_short";
  detail: string;
  transient: boolean;
  status?: number;
}

/**
 * SSE 的 item 事件载荷中的结果联合类型。
 */
type WireResult = WireSuccess | WireFailure;

interface EntryState {
  status: "待抓取" | "抓取中" | "已就绪" | "失败" | "已留下" | "已划掉" | "处理中";
  result?: WireResult;
  expanded?: boolean;
  editTitle?: string; // 编辑中的标题
}

interface InboxState {
  entries: InboxEntry[];
  matchedFolders: string[];
}

interface FetchProgress {
  done: number;
  total: number;
}

export function App() {
  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [progress, setProgress] = useState<FetchProgress>({ done: 0, total: 0 });
  const [entryStates, setEntryStates] = useState<Map<string, EntryState>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const jobIdRef = useRef<string>("");

  // 加载收件箱
  useEffect(() => {
    const loadInbox = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/inbox");
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Failed to load inbox");
        }
        const data = (await response.json()) as InboxState;
        setInbox(data);

        // 初始化条目状态
        const states = new Map<string, EntryState>();
        for (const entry of data.entries) {
          states.set(entry.url, { status: "待抓取" });
        }
        setEntryStates(states);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    loadInbox();
  }, []);

  // 启动抓取
  const startFetch = async () => {
    if (isFetching || !inbox) return;

    try {
      setIsFetching(true);
      setProgress({ done: 0, total: inbox.entries.length });

      const response = await fetch("http://localhost:3001/api/inbox/fetch", {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to start fetch");
      }

      const data = (await response.json()) as { jobId: string; total: number };
      jobIdRef.current = data.jobId;

      // 订阅事件
      subscribeToEvents(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsFetching(false);
    }
  };

  // 订阅 SSE 事件
  const subscribeToEvents = (jobId: string) => {
    // 关闭任何现有的连接
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`http://localhost:3001/api/inbox/events?jobId=${jobId}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("progress", (event) => {
      const data = JSON.parse(event.data);
      setProgress({
        done: data.done,
        total: data.total,
      });

      // 更新该 URL 的状态为"抓取中"
      setEntryStates((prev) => {
        const updated = new Map(prev);
        if (updated.has(data.url)) {
          const state = updated.get(data.url)!;
          if (state.status !== "已就绪" && state.status !== "失败") {
            updated.set(data.url, { ...state, status: "抓取中" });
          }
        }
        return updated;
      });
    });

    eventSource.addEventListener("item", (event) => {
      const { url, result } = JSON.parse(event.data);

      // 更新该条目的状态和结果
      setEntryStates((prev) => {
        const updated = new Map(prev);
        if (result.ok) {
          updated.set(url, {
            status: "已就绪",
            result,
            expanded: false,
          });
        } else {
          updated.set(url, {
            status: "失败",
            result,
          });
        }
        return updated;
      });
    });

    eventSource.addEventListener("done", () => {
      setIsFetching(false);
      eventSource.close();
      eventSourceRef.current = null;
    });

    eventSource.onerror = () => {
      eventSource.close();
      eventSourceRef.current = null;
      setIsFetching(false);
      setError("Connection to server lost");
    };
  };

  // 清理
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // 切换条目展开状态
  const toggleExpanded = (url: string) => {
    setEntryStates((prev) => {
      const updated = new Map(prev);
      const state = updated.get(url);
      if (state) {
        updated.set(url, { ...state, expanded: !state.expanded });
      }
      return updated;
    });
  };

  // 保留条目
  const handleKeep = async (url: string) => {
    const state = entryStates.get(url);
    if (!state || !state.result || !state.result.ok) return;

    try {
      setEntryStates((prev) => {
        const updated = new Map(prev);
        updated.set(url, { ...state, status: "处理中" });
        return updated;
      });

      const title = state.editTitle || state.result.title;

      const response = await fetch("http://localhost:3001/api/inbox/keep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title,
        }),
      });

      if (!response.ok) {
        const data = await response.json();

        // 处理 410 Gone：缓存已失效，需要重新抓取
        if (response.status === 410) {
          setError("提取的正文已过期，需要重新抓取。请点击「开始抓取」重新抓取此条目。");
          setEntryStates((prev) => {
            const updated = new Map(prev);
            updated.set(url, { ...state, status: "待抓取" });
            return updated;
          });
          return;
        }

        setError(data.error || "Failed to keep entry");
        setEntryStates((prev) => {
          const updated = new Map(prev);
          updated.set(url, { ...state, status: "已就绪" });
          return updated;
        });
        return;
      }

      setEntryStates((prev) => {
        const updated = new Map(prev);
        updated.set(url, { ...state, status: "已留下" });
        return updated;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setEntryStates((prev) => {
        const updated = new Map(prev);
        updated.set(url, { ...state, status: "已就绪" });
        return updated;
      });
    }
  };

  // 划掉条目
  const handleDrop = async (url: string) => {
    const state = entryStates.get(url);
    if (!state) return;

    try {
      setEntryStates((prev) => {
        const updated = new Map(prev);
        updated.set(url, { ...state, status: "处理中" });
        return updated;
      });

      const response = await fetch("http://localhost:3001/api/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || "Failed to drop entry");
        setEntryStates((prev) => {
          const updated = new Map(prev);
          const currentState = updated.get(url) || state;
          updated.set(url, { ...currentState, status: state.status });
          return updated;
        });
        return;
      }

      setEntryStates((prev) => {
        const updated = new Map(prev);
        updated.set(url, { ...state, status: "已划掉" });
        return updated;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setEntryStates((prev) => {
        const updated = new Map(prev);
        const currentState = updated.get(url) || state;
        updated.set(url, { ...currentState, status: state.status });
        return updated;
      });
    }
  };

  if (loading) {
    return <div style={{ padding: "20px" }}>加载中...</div>;
  }

  if (error && !inbox) {
    return <div style={{ padding: "20px", color: "red" }}>错误：{error}</div>;
  }

  if (!inbox) {
    return <div style={{ padding: "20px" }}>No inbox data</div>;
  }

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <h1>Zhandao 过闸</h1>

      {error && <div style={{ padding: "10px", backgroundColor: "#fee", color: "#c33", marginBottom: "20px", borderRadius: "4px" }}>{error}</div>}

      <div style={{ marginBottom: "20px", padding: "15px", backgroundColor: "#f5f5f5", borderRadius: "4px" }}>
        <div style={{ marginBottom: "10px" }}>
          <strong>收件箱：</strong> {inbox.entries.length} 条
        </div>
        <div style={{ marginBottom: "10px" }}>
          <strong>匹配的文件夹：</strong> {inbox.matchedFolders.join(" / ")}
        </div>
        <button
          onClick={startFetch}
          disabled={isFetching}
          style={{
            padding: "8px 16px",
            backgroundColor: isFetching ? "#ccc" : "#007bff",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isFetching ? "not-allowed" : "pointer",
            fontSize: "14px",
          }}
        >
          {isFetching ? "抓取中..." : "开始抓取"}
        </button>

        {isFetching && (
          <div style={{ marginTop: "10px" }}>
            <div>
              进度: {progress.done} / {progress.total}
            </div>
            <div style={{ width: "100%", height: "20px", backgroundColor: "#e0e0e0", borderRadius: "4px", marginTop: "5px", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : "0%",
                  backgroundColor: "#007bff",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: "20px" }}>
        <h2>条目列表</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {inbox.entries.map((entry) => {
            const state = entryStates.get(entry.url) || { status: "待抓取" as const };
            const statusColor = {
              待抓取: "#999",
              抓取中: "#ff9800",
              已就绪: "#4caf50",
              失败: "#f44336",
              已留下: "#4caf50",
              已划掉: "#999",
              处理中: "#ff9800",
            }[state.status];

            const hostname = new URL(entry.url).hostname;
            const dateStr = entry.addedAt ? new Date(entry.addedAt).toLocaleDateString("zh-Hans") : "-";

            return (
              <div
                key={entry.url}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  overflow: "hidden",
                  backgroundColor: "white",
                }}
              >
                {/* 第一行：标题和操作按钮 */}
                {(state.status === "待抓取" || state.status === "抓取中" || state.status === "处理中") && (
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "14px", color: "#333", wordBreak: "break-word" }}>
                          {entry.title}
                        </div>
                      </div>
                      <span style={{ color: statusColor, fontWeight: "bold", fontSize: "12px", whiteSpace: "nowrap" }}>
                        {state.status}
                      </span>
                    </div>
                  </div>
                )}

                {state.status === "已就绪" && state.result && state.result.ok && (
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="text"
                        value={state.editTitle ?? state.result.title}
                        onChange={(e) => {
                          setEntryStates((prev) => {
                            const updated = new Map(prev);
                            const currentState = updated.get(entry.url) || state;
                            updated.set(entry.url, {
                              ...currentState,
                              editTitle: e.target.value,
                            });
                            return updated;
                          });
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "8px",
                          borderRadius: "4px",
                          border: "1px solid #ddd",
                          fontSize: "14px",
                        }}
                      />
                      <button
                        onClick={() => handleKeep(entry.url)}
                        disabled={state.status !== "已就绪"}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#4caf50",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        留下
                      </button>
                      <button
                        onClick={() => handleDrop(entry.url)}
                        disabled={state.status !== "已就绪"}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#f44336",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        划掉
                      </button>
                    </div>
                  </div>
                )}

                {state.status === "失败" && state.result && !state.result.ok && (
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "14px", color: "#333", wordBreak: "break-word" }}>
                          {entry.title}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDrop(entry.url)}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#f44336",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                          fontSize: "12px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        划掉
                      </button>
                    </div>
                  </div>
                )}

                {(state.status === "已留下" || state.status === "已划掉") && (
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "14px", color: "#333", wordBreak: "break-word" }}>
                          {entry.title}
                        </div>
                      </div>
                      <span style={{ color: statusColor, fontWeight: "bold", fontSize: "12px", whiteSpace: "nowrap" }}>
                        {state.status === "已留下" ? "✓ 已留下" : "✓ 已划掉"}
                      </span>
                    </div>
                  </div>
                )}

                {/* 第二行：元数据和展开按钮 */}
                <div style={{ padding: "8px 16px", display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "#666" }}>
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#007bff", textDecoration: "none", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={entry.url}
                  >
                    {hostname}
                  </a>
                  <span style={{ whiteSpace: "nowrap" }}>{dateStr}</span>
                  {state.status === "失败" && state.result && !state.result.ok && (
                    <span style={{ color: "#f44336", whiteSpace: "nowrap" }}>
                      {state.result.reason} {state.result.transient ? "(临时)" : "(永久)"}
                    </span>
                  )}
                  {state.status === "已就绪" && state.result && state.result.ok && (
                    <button
                      onClick={() => toggleExpanded(entry.url)}
                      style={{
                        padding: "4px 8px",
                        backgroundColor: "#f0f0f0",
                        border: "1px solid #ddd",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {state.expanded ? "收起" : "展开"}
                    </button>
                  )}
                </div>

                {/* 展开面板：深入内容 */}
                {state.status === "已就绪" && state.expanded && state.result && state.result.ok && (
                  <div style={{ padding: "12px 16px", backgroundColor: "#f9f9f9", borderTop: "1px solid #f0f0f0" }}>
                    <div style={{ marginBottom: "12px" }}>
                      <strong style={{ fontSize: "12px", color: "#666" }}>抽取标题：</strong>
                      <div style={{ fontSize: "13px", marginTop: "4px", color: "#333" }}>{state.result.title}</div>
                    </div>
                    <div style={{ marginBottom: "12px" }}>
                      <strong style={{ fontSize: "12px", color: "#666" }}>字数：</strong>
                      <div style={{ fontSize: "13px", marginTop: "4px", color: "#333" }}>{state.result.textLength}</div>
                    </div>
                    <div style={{ marginBottom: "12px" }}>
                      <strong style={{ fontSize: "12px", color: "#666" }}>最终 URL：</strong>
                      <div style={{ fontSize: "12px", marginTop: "4px", color: "#007bff", wordBreak: "break-all" }}>
                        <a href={state.result.finalUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#007bff", textDecoration: "none" }}>
                          {state.result.finalUrl}
                        </a>
                      </div>
                    </div>
                    <div>
                      <strong style={{ fontSize: "12px", color: "#666" }}>正文开头：</strong>
                      <pre
                        style={{
                          backgroundColor: "#fff",
                          padding: "8px",
                          borderRadius: "4px",
                          border: "1px solid #e0e0e0",
                          maxHeight: "200px",
                          overflow: "auto",
                          marginTop: "4px",
                          fontSize: "12px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "#333",
                        }}
                      >
                        {state.result.markdown}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
