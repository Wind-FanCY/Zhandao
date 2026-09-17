import { useState, useEffect, useCallback, useMemo } from "react";
import type { CSSProperties, ReactElement } from "react";

/**
 * 阅读视图：推送把你指向一篇**材料**，这里读它，然后走三个终态之一
 * ——写**标注** / **留档** / 划掉。见 CLAUDE.md「推送链路的实现约束」。
 *
 * 刻意不显示待处理总数：每天提醒本人欠着几十篇会让人不想打开它，
 * 而「任何让收录或标注变麻烦的设计都在削弱这个项目」。
 */

interface PoolItem {
  id: string;
  title: string;
  source: string;
  kind: string;
  since: string;
}

interface Annotation {
  id: string;
  text: string;
  at: string;
}

interface MaterialDetail {
  id: string;
  title: string;
  source: string;
  captured: string;
  from?: string;
  markdown: string;
  annotations: Annotation[];
}

const API = "http://localhost:3001";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPoolItem(v: unknown): v is PoolItem {
  if (!isRecord(v)) return false;
  for (const k of ["id", "title", "source", "kind", "since"]) {
    if (!(k in v) || typeof v[k] !== "string") return false;
  }
  return true;
}

function isAnnotation(v: unknown): v is Annotation {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" && typeof v.text === "string" && typeof v.at === "string"
  );
}

function parseDetail(v: unknown): MaterialDetail | null {
  if (!isRecord(v)) return null;
  const { id, title, source, captured, markdown, from, annotations } = v;
  if (typeof id !== "string" || typeof title !== "string") return null;
  if (typeof source !== "string" || typeof markdown !== "string") return null;
  return {
    id,
    title,
    source,
    captured: typeof captured === "string" ? captured : "",
    from: typeof from === "string" ? from : undefined,
    markdown,
    annotations: Array.isArray(annotations) ? annotations.filter(isAnnotation) : [],
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 最小渲染：按 ``` 切开，代码块用等宽 + 底色，正文按原样保留换行，图片折叠成标记。
 *
 * 刻意**不**引入 markdown 渲染库：那是一个依赖决定，该由本人拍。
 * 这个版本把最要紧的区分（代码 vs 正文）做出来了，标题会以 `## ` 原样出现
 * ——看着糙，但那反而让文章结构一眼可见。装了 react-markdown 会好很多。
 */
function renderBody(markdown: string): ReactElement[] {
  const chunks = markdown.split("```");
  return chunks.map((chunk, i) => {
    if (i % 2 === 1) {
      // 奇数块在一对 ``` 之间 = 代码。第一行可能是语言标记，去掉它
      const nl = chunk.indexOf("\n");
      const code = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      return (
        <pre
          key={i}
          style={{
            backgroundColor: "#f6f8fa",
            border: "1px solid #e1e4e8",
            borderRadius: "4px",
            padding: "10px 12px",
            overflowX: "auto",
            fontSize: "13px",
            lineHeight: 1.5,
            margin: "10px 0",
          }}
        >
          {code}
        </pre>
      );
    }
    // 图片折叠：materials 里的图片 URL 极长，展开会把正文冲散
    const prose = chunk.replace(/!\[[^\]]*\]\([^)]*\)/g, "〔图〕");
    return (
      <div key={i} style={{ whiteSpace: "pre-wrap", fontSize: "15px", lineHeight: 1.85 }}>
        {prose}
      </div>
    );
  });
}

/**
 * 笔记输入框单独成组件、自己管自己的 state。
 *
 * 原先 `noteText` 放在 `Read` 里，于是**每敲一个键都会重渲染整篇正文**——
 * 而正文被 renderBody 切成「围栏数 + 1」个块，库里最极端的一篇有 244 个围栏、
 * 也就是 245 个块，是其余材料的 9 倍。左边 46 个按钮也一起跟着重渲染。
 * 拆出来之后打字完全不触及 Read。
 */
function NoteEditor({ busy, onSubmit }: { busy: boolean; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const empty = text.trim().length === 0;
  return (
    <>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="读完有什么理解？写一句就够——这才是这个库唯一值钱的东西"
        rows={3}
        style={{
          width: "100%",
          fontFamily: "inherit",
          fontSize: "15px",
          lineHeight: 1.6,
          padding: "10px",
          border: "1px solid #ccc",
          borderRadius: "4px",
          resize: "vertical",
        }}
      />
      <button
        onClick={() => {
          onSubmit(text);
          setText("");
        }}
        disabled={busy || empty}
        style={{
          padding: "8px 18px",
          marginTop: "10px",
          backgroundColor: busy || empty ? "#ccc" : "#4caf50",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: busy || empty ? "not-allowed" : "pointer",
        }}
      >
        写标注
      </button>
    </>
  );
}

export function Read({ active }: { active: boolean }) {
  const [pool, setPool] = useState<PoolItem[] | null>(null);
  const [todayId, setTodayId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadPool = useCallback(async () => {
    try {
      const [poolRes, todayRes] = await Promise.all([
        fetch(`${API}/api/materials/pool`),
        fetch(`${API}/api/push/today`),
      ]);
      if (!poolRes.ok) throw new Error(`GET /api/materials/pool → ${poolRes.status}`);
      const poolBody: unknown = await poolRes.json();
      const items =
        isRecord(poolBody) && Array.isArray(poolBody.candidates)
          ? poolBody.candidates.filter(isPoolItem)
          : [];
      setPool(items);
      setError(null);

      if (todayRes.ok) {
        const t: unknown = await todayRes.json();
        const c = isRecord(t) && isRecord(t.candidate) ? t.candidate : null;
        setTodayId(c !== null && typeof c.id === "string" ? c.id : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (active) void loadPool();
  }, [active, loadPool]);

  const open = async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setConfirmDrop(false);
    setDone(null);
    try {
      const res = await fetch(`${API}/api/materials/${id}`);
      if (!res.ok) throw new Error(`GET /api/materials/${id} → ${res.status}`);
      const parsed = parseDetail(await res.json());
      if (parsed === null) throw new Error("材料响应形状不对");
      setDetail(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (path: string, body?: unknown, label?: string) => {
    if (openId === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/materials/${openId}/${path}`, {
        method: "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const b: unknown = await res.json().catch(() => null);
        const msg =
          isRecord(b) && typeof b.error === "string" ? b.error : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setDone(label ?? "完成");
      await loadPool();
      // 划掉之后这篇材料已经不存在了，详情不能再留在屏幕上
      if (path === "drop") {
        setDetail(null);
        setOpenId(null);
      } else if (path === "annotate") {
        await open(openId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmDrop(false);
    }
  };

  // memo 化：引用不变时 React 会跳过整棵子树的重渲染。
  // 依赖只有 detail——正文不可改（CONTEXT.md：材料正文是来源原文不可改）。
  const body = useMemo(() => (detail === null ? null : renderBody(detail.markdown)), [detail]);

  if (error !== null && pool === null) {
    return <div style={{ padding: "20px", color: "#c33" }}>错误：{error}</div>;
  }
  if (pool === null) return <div style={{ padding: "20px" }}>加载中...</div>;

  const btn = (bg: string): CSSProperties => ({
    padding: "8px 18px",
    backgroundColor: busy ? "#ccc" : bg,
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: busy ? "not-allowed" : "pointer",
  });

  return (
    <div style={{ display: "flex", gap: "20px", alignItems: "stretch", flex: 1, minHeight: 0 }}>
      {/* 左：可浏览的列表。「界面必须支持浏览，不能只有搜索」 */}
      <div style={{ width: "300px", flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {todayId !== null && (
          <div
            style={{
              padding: "8px 10px",
              backgroundColor: "#e8f5e9",
              border: "1px solid #a5d6a7",
              borderRadius: "4px",
              fontSize: "13px",
              marginBottom: "10px",
              color: "#2e7d32",
            }}
          >
            今天推送的是下面高亮那篇
          </div>
        )}
        {/* overscrollBehavior: contain 断掉滚动链：不加的话列表滚到底之后，
            滚轮会继续滚外层——而正文那一栏很长，那次滚动要重绘大量 pre-wrap 文本。 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            // contain: paint 告诉浏览器这个盒子内部的重绘不会影响外面，
            // 滚动时的重绘范围被限死在这 300px 宽的框里。
            // 刻意不用 will-change: transform——那会永久占一个合成层，
            // 而这里只有 46 个按钮，用不上那么重的手段。
            contain: "paint",
          }}
        >
          {pool.length === 0 && (
            <div style={{ color: "#999", fontSize: "13px", padding: "8px" }}>
              没有待处理的<strong>材料</strong>——都消化过了。
            </div>
          )}
          {pool.map((m) => (
            <button
              key={m.id}
              onClick={() => void open(m.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                marginBottom: "4px",
                border: `1px solid ${m.id === todayId ? "#4caf50" : openId === m.id ? "#007bff" : "#eee"}`,
                borderRadius: "4px",
                backgroundColor:
                  m.id === todayId ? "#f1f8e9" : openId === m.id ? "#f0f7ff" : "white",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {m.title}
              <span style={{ display: "block", fontSize: "11px", color: "#aaa", marginTop: "2px" }}>
                {m.kind} · {hostnameOf(m.source)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 右：读 + 三个终态 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", overscrollBehavior: "contain", minHeight: 0 }}>
        {openId === null && (
          <div style={{ color: "#999", padding: "20px" }}>从左边选一篇开始读。</div>
        )}
        {openId !== null && detail === null && <div style={{ padding: "20px" }}>读取中...</div>}
        {detail !== null && (
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: "6px",
              backgroundColor: "white",
              padding: "18px 20px",
            }}
          >
            <h2 style={{ marginBottom: "6px", fontSize: "19px" }}>{detail.title}</h2>
            <div style={{ fontSize: "12px", color: "#999", marginBottom: "14px" }}>
              <a href={detail.source} target="_blank" rel="noreferrer">
                {hostnameOf(detail.source)}
              </a>
              {detail.from !== undefined && <> · 展开自 {hostnameOf(detail.from)}</>}
            </div>

            {detail.annotations.length > 0 && (
              <div
                style={{
                  backgroundColor: "#f0f7ff",
                  border: "1px solid #cfe3ff",
                  borderRadius: "4px",
                  padding: "10px 12px",
                  marginBottom: "16px",
                }}
              >
                <div style={{ fontSize: "12px", color: "#667", marginBottom: "6px" }}>
                  这篇上已有的标注
                </div>
                {detail.annotations.map((a) => (
                  <div key={a.id} style={{ fontSize: "14px", lineHeight: 1.7, marginBottom: "4px" }}>
                    · {a.text}
                  </div>
                ))}
              </div>
            )}

            {/* 三个终态的控件都在默认视图里——决定所需的控件藏起来就等于不存在 */}
            <div style={{ borderTop: "1px solid #eee", paddingTop: "14px", marginBottom: "18px" }}>
              <NoteEditor busy={busy} onSubmit={(text) => void act("annotate", { text }, "标注已写入")} />
              <div style={{ display: "flex", gap: "10px", marginTop: "10px", alignItems: "center" }}>
                <button onClick={() => void act("archive", undefined, "已留档")} disabled={busy} style={btn("#ff9800")}>
                  留档（没什么可写）
                </button>
                {!confirmDrop ? (
                  <button onClick={() => setConfirmDrop(true)} disabled={busy} style={btn("#9e9e9e")}>
                    划掉
                  </button>
                ) : (
                  <>
                    <button onClick={() => void act("drop", undefined, "已划掉")} disabled={busy} style={btn("#f44336")}>
                      确认删除这篇材料
                    </button>
                    <button onClick={() => setConfirmDrop(false)} style={{ ...btn("#fff"), color: "#666", border: "1px solid #ccc" }}>
                      取消
                    </button>
                  </>
                )}
                {done !== null && <span style={{ color: "#4caf50", fontSize: "13px" }}>{done}</span>}
                {error !== null && <span style={{ color: "#c33", fontSize: "13px" }}>{error}</span>}
              </div>
              {confirmDrop && (
                <div style={{ fontSize: "12px", color: "#c33", marginTop: "8px" }}>
                  会删掉磁盘上的材料文件。`data/` 是 git 仓库，已提交过的还能找回来；刚收录还没提交的找不回。
                </div>
              )}
            </div>

            <div style={{ borderTop: "1px solid #eee", paddingTop: "14px" }}>{body}</div>
          </div>
        )}
      </div>
    </div>
  );
}
