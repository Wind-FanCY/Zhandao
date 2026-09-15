import { useState, useEffect, useRef } from "react";

interface InboxEntry {
  title: string;
  url: string;
  folderPath: string;
  addedAt: string | null;
}

interface ExtractResult {
  ok: boolean;
  [key: string]: unknown;
}

interface EntryState {
  status: "待抓取" | "抓取中" | "已就绪" | "失败";
  result?: ExtractResult;
  expanded?: boolean;
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
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #ddd" }}>
              <th style={{ textAlign: "left", padding: "10px", fontWeight: "bold" }}>书签标题</th>
              <th style={{ textAlign: "left", padding: "10px", fontWeight: "bold" }}>URL</th>
              <th style={{ textAlign: "left", padding: "10px", fontWeight: "bold" }}>添加日期</th>
              <th style={{ textAlign: "left", padding: "10px", fontWeight: "bold" }}>状态</th>
            </tr>
          </thead>
          <tbody>
            {inbox.entries.map((entry) => {
              const state = entryStates.get(entry.url) || { status: "待抓取" as const };
              const statusColor = {
                待抓取: "#999",
                抓取中: "#ff9800",
                已就绪: "#4caf50",
                失败: "#f44336",
              }[state.status];

              return (
                <>
                  <tr style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "10px", verticalAlign: "middle" }}>
                      <div style={{ maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.title}</div>
                    </td>
                    <td style={{ padding: "10px", verticalAlign: "middle" }}>
                      <a href={entry.url} target="_blank" rel="noopener noreferrer" style={{ color: "#007bff", textDecoration: "none", fontSize: "12px" }}>
                        {new URL(entry.url).hostname}
                      </a>
                    </td>
                    <td style={{ padding: "10px", verticalAlign: "middle", fontSize: "12px" }}>
                      {entry.addedAt ? new Date(entry.addedAt).toLocaleDateString("zh-Hans") : "-"}
                    </td>
                    <td style={{ padding: "10px", verticalAlign: "middle" }}>
                      <span style={{ color: statusColor, fontWeight: "bold", fontSize: "14px" }}>{state.status}</span>
                      {state.status === "已就绪" && state.result && (
                        <button
                          onClick={() => toggleExpanded(entry.url)}
                          style={{
                            marginLeft: "8px",
                            padding: "4px 8px",
                            backgroundColor: "#e8f5e9",
                            border: "1px solid #4caf50",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                        >
                          {state.expanded ? "收起" : "展开"}
                        </button>
                      )}
                      {state.status === "失败" && state.result && (
                        <div style={{ marginLeft: "8px", fontSize: "12px", color: "#f44336" }}>
                          {(state.result as any).reason} {(state.result as any).transient ? "(临时失败)" : "(永久失败)"}
                        </div>
                      )}
                    </td>
                  </tr>

                  {state.status === "已就绪" && state.expanded && state.result && (state.result as any).ok && (
                    <tr style={{ backgroundColor: "#f9f9f9" }}>
                      <td colSpan={4} style={{ padding: "15px" }}>
                        <div>
                          <strong>抽取标题：</strong> {(state.result as any).title}
                        </div>
                        <div style={{ marginTop: "10px" }}>
                          <strong>字数：</strong> {(state.result as any).textLength}
                        </div>
                        <div style={{ marginTop: "10px" }}>
                          <strong>正文开头：</strong>
                          <pre
                            style={{
                              backgroundColor: "#f5f5f5",
                              padding: "10px",
                              borderRadius: "4px",
                              maxHeight: "200px",
                              overflow: "auto",
                              marginTop: "5px",
                              fontSize: "12px",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {(state.result as any).markdown}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
