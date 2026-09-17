import { useState, useEffect, useCallback } from "react";

/**
 * 归属界面：把一条**速记**挂到某份**材料**上，使它成为一条**标注**。
 *
 * 这个文件的形状由几条已记录的约束决定，改之前先读 CLAUDE.md 的「归属链路的实现约束」：
 * - 候选宿主是 BM25 直出的 3 个，不调模型（索引时翻译之后 recall@3=100%，量过的）。
 * - 「都不合适」是一等公民动作，不设自动阈值——BM25 总会返回三个，即使全不相关。
 * - textarea、候选、按钮全部在默认视图里。可选步骤一旦需要额外点击，在批量流程里就等于不存在。
 */

/** 服务端返回的候选宿主。这是 wire 格式，不是服务端内部的 IndexedMaterial。 */
interface Candidate {
  id: string;
  title: string;
  source: string;
  score: number;
}

/** 库里的一份材料，用于「都不合适」时浏览全部。 */
interface Material {
  id: string;
  title: string;
  source: string;
}

interface PendingNote {
  id: string;
  text: string;
  /** ISO 8601 */
  at: string;
  /** 模型从原文提炼出的检索查询。提炼失败时为空串 */
  query: string;
  /** 提炼是否成功。失败时 candidates 一定是空数组——见 CLAUDE.md「归属链路」Q5 那条 */
  queryOk: boolean;
  candidates: Candidate[];
}

/** 每条速记的界面状态。`selected` 为 null 表示还没选定宿主。 */
interface NoteUIState {
  text: string;
  selected: string | null;
  /** 是否展开了全部材料列表。与 selected 分开存，否则从列表里选中一项就会把列表收起来。 */
  browsing: boolean;
  status: "待定" | "提交中" | "已归属" | "已丢弃";
  filter: string;
  /** 提炼出的检索查询，可编辑。改完点「重搜」会替换候选 */
  query: string;
  /** 候选放在 state 里而不是直接读 note.candidates：重搜要能就地替换它们 */
  candidates: Candidate[];
  searching: boolean;
  error?: string;
}

// 外部数据进来必须校验而不是断言：`res.json()` 的静态类型是 any，
// 直接赋给 PendingNote[] 等于什么都没检查。见 CLAUDE.md「外部数据必须校验」。
// 用 `in` 收窄而不是 `as Record<string, unknown>`：断言会关掉检查，
// 而 TS 4.9 起 `in` 能把 unknown 收窄出这个键，编译器自己推得出类型。
function isCandidate(v: unknown): v is Candidate {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || typeof v.id !== "string") return false;
  if (!("title" in v) || typeof v.title !== "string") return false;
  if (!("source" in v) || typeof v.source !== "string") return false;
  if (!("score" in v) || typeof v.score !== "number") return false;
  return true;
}

function isMaterial(v: unknown): v is Material {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || typeof v.id !== "string") return false;
  if (!("title" in v) || typeof v.title !== "string") return false;
  if (!("source" in v) || typeof v.source !== "string") return false;
  return true;
}

function parseMaterials(payload: unknown): Material[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (!("materials" in payload) || !Array.isArray(payload.materials)) return [];
  return payload.materials.filter(isMaterial);
}

function isPendingNote(v: unknown): v is PendingNote {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || typeof v.id !== "string") return false;
  if (!("text" in v) || typeof v.text !== "string") return false;
  if (!("at" in v) || typeof v.at !== "string") return false;
  if (!("query" in v) || typeof v.query !== "string") return false;
  if (!("queryOk" in v) || typeof v.queryOk !== "boolean") return false;
  if (!("candidates" in v) || !Array.isArray(v.candidates)) return false;
  return v.candidates.every(isCandidate);
}

function parseNotes(payload: unknown): PendingNote[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (!("notes" in payload) || !Array.isArray(payload.notes)) return [];
  // 坏条目跳过而不是整页报错：一条脏数据不该挡住其余待归属的速记
  return payload.notes.filter(isPendingNote);
}

/** 从错误响应体里取出服务端给的说明；取不到就退回状态码。 */
function errorMessageOf(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `HTTP ${status}`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const API = "http://localhost:3001";

export function Attach({ active, onPendingCount }: { active: boolean; onPendingCount: (n: number) => void }) {
  const [notes, setNotes] = useState<PendingNote[] | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [states, setStates] = useState<Map<string, NoteUIState>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, matRes] = await Promise.all([
        fetch(`${API}/api/notes/pending`),
        fetch(`${API}/api/materials`),
      ]);
      if (!res.ok) throw new Error(`GET /api/notes/pending → ${res.status}`);
      if (!matRes.ok) throw new Error(`GET /api/materials → ${matRes.status}`);
      const parsed = parseNotes(await res.json());
      setMaterials(parseMaterials(await matRes.json()));
      setNotes(parsed);
      setLoadError(null);
      setStates(
        new Map(
          parsed.map((n) => [
            n.id,
            {
              text: n.text,
              selected: null,
              // 提炼失败时直接把全部材料列表展开：退回用原文搜会给出三个
              // 看起来正常、实际全错的候选，而人不知道提炼失败了。见 CLAUDE.md。
              browsing: !n.queryOk,
              status: "待定" as const,
              filter: "",
              query: n.query,
              candidates: n.candidates,
              searching: false,
            },
          ]),
        ),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 切回本视图时重新拉取：在「过闸」里新收录的材料会改变候选，
  // 而候选是这个界面唯一的决策依据，拿旧的等于拿错的。
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // 待办计数从 states 派生，不在每个动作里各算一次——手算过一版，
  // 用的是 notes.length（它不变），连续处理两条时两次都报成 length - 1。
  useEffect(() => {
    if (notes === null) return;
    let settled = 0;
    for (const s of states.values()) {
      if (s.status === "已归属" || s.status === "已丢弃") settled += 1;
    }
    onPendingCount(notes.length - settled);
  }, [notes, states, onPendingCount]);

  const patch = (id: string, next: Partial<NoteUIState>) => {
    setStates((prev) => {
      const updated = new Map(prev);
      const current = updated.get(id);
      if (!current) return prev;
      updated.set(id, { ...current, ...next });
      return updated;
    });
  };

  const attach = async (note: PendingNote) => {
    const state = states.get(note.id);
    if (!state || state.selected === null) return;
    patch(note.id, { status: "提交中", error: undefined });
    try {
      const res = await fetch(`${API}/api/notes/${note.id}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: state.text, materialId: state.selected }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(errorMessageOf(body, res.status));
      }
      patch(note.id, { status: "已归属" });
    } catch (err) {
      patch(note.id, { status: "待定", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const drop = async (note: PendingNote) => {
    patch(note.id, { status: "提交中", error: undefined });
    try {
      const res = await fetch(`${API}/api/notes/${note.id}/drop`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      patch(note.id, { status: "已丢弃" });
    } catch (err) {
      patch(note.id, { status: "待定", error: err instanceof Error ? err.message : String(err) });
    }
  };

  // 改了查询之后重搜。刻意走一个通用的 /api/search 而不是 note 作用域的端点：
  // 搜索本身跟这条速记无关，查询已经被人接管了。
  const research = async (note: PendingNote) => {
    const state = states.get(note.id);
    if (!state) return;
    const q = state.query.trim();
    if (q.length === 0) return;
    patch(note.id, { searching: true, error: undefined });
    try {
      const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&limit=3`);
      if (!res.ok) throw new Error(`GET /api/search → ${res.status}`);
      const body: unknown = await res.json();
      const found =
        typeof body === "object" && body !== null && "candidates" in body && Array.isArray(body.candidates)
          ? body.candidates.filter(isCandidate)
          : [];
      patch(note.id, { candidates: found, searching: false, selected: null });
    } catch (err) {
      patch(note.id, {
        searching: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (loadError !== null) {
    return <div style={{ padding: "20px", color: "#c33" }}>错误：{loadError}</div>;
  }
  if (notes === null) {
    return <div style={{ padding: "20px" }}>加载中...</div>;
  }
  if (notes.length === 0) {
    return (
      <div style={{ padding: "20px", color: "#666", lineHeight: 1.8 }}>
        没有待归属的<strong>速记</strong>。
        <br />
        在终端记一条：<code style={{ background: "#f0f0f0", padding: "2px 6px", borderRadius: "3px" }}>npm run note -- "一句话"</code>
        <br />
        <span style={{ fontSize: "13px", color: "#999" }}>不需要服务在跑，见 ADR-0009。</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {notes.map((note) => {
        const state =
          states.get(note.id) ??
          {
            text: note.text,
            selected: null,
            browsing: !note.queryOk,
            status: "待定" as const,
            filter: "",
            query: note.query,
            candidates: note.candidates,
            searching: false,
          };
        const settled = state.status === "已归属" || state.status === "已丢弃";
        const canAttach =
          state.selected !== null && state.text.trim().length > 0;

        return (
          <div
            key={note.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: "6px",
              backgroundColor: "white",
              padding: "16px",
              opacity: settled ? 0.55 : 1,
            }}
          >
            {/* 那句话可编辑，标注文件的正文才是真相源；quicknotes.jsonl 那行不动。
                见 CONTEXT.md 的 Flagged ambiguities。 */}
            <textarea
              value={state.text}
              onChange={(e) => patch(note.id, { text: e.target.value })}
              disabled={settled || state.status === "提交中"}
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

            <div style={{ fontSize: "12px", color: "#999", margin: "6px 0 12px" }}>
              记于 {new Date(note.at).toLocaleString("zh-Hans")}
              {settled && <strong style={{ color: "#4caf50", marginLeft: "10px" }}>{state.status}</strong>}
            </div>

            {!settled && (
              <>
                {/* 提炼出的查询必须可见可编辑、且在默认视图里：它是这一轮的「标题输入框」，
                    决定候选的控件藏起来就等于不存在（过闸那条实测教训）。
                    作用是把静默失效变成可见失效——看到查询里写着「代理 系统功能」就知道模型抽歪了。 */}
                <div style={{ fontSize: "13px", color: "#666", marginBottom: "6px" }}>
                  检索查询（模型从原文提炼，可改）
                </div>
                <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
                  <input
                    value={state.query}
                    onChange={(e) => patch(note.id, { query: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void research(note);
                    }}
                    placeholder="例如：undici http_proxy 代理"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "7px 10px",
                      fontSize: "14px",
                      fontFamily: "inherit",
                      border: `1px solid ${note.queryOk ? "#ccc" : "#ffb74d"}`,
                      borderRadius: "4px",
                    }}
                  />
                  <button
                    onClick={() => void research(note)}
                    disabled={state.searching || state.query.trim().length === 0}
                    style={{
                      padding: "7px 14px",
                      backgroundColor: state.searching || state.query.trim().length === 0 ? "#ccc" : "#007bff",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: state.searching ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {state.searching ? "搜索中..." : "重搜"}
                  </button>
                </div>

                {!note.queryOk && (
                  <div
                    style={{
                      marginBottom: "12px",
                      padding: "10px 12px",
                      backgroundColor: "#fff3e0",
                      border: "1px solid #ffb74d",
                      borderRadius: "4px",
                      fontSize: "13px",
                      lineHeight: 1.7,
                      color: "#7a4a00",
                    }}
                  >
                    <strong>自动提炼失败</strong>，所以候选是空的。
                    <br />
                    这是刻意的：失败时退回用速记原文去搜，会给出三个看起来正常、
                    <strong>实际全错</strong>的候选，而你不会知道提炼失败过。
                    <br />
                    下面的全部材料列表已经展开，直接挑；或者在上面敲一个查询点「重搜」。
                  </div>
                )}

                <div style={{ fontSize: "13px", color: "#666", marginBottom: "8px" }}>
                  挂到哪份<strong>材料</strong>上？
                </div>

                {state.candidates.map((c) => (
                  <label
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "8px 10px",
                      border: `1px solid ${state.selected === c.id ? "#007bff" : "#eee"}`,
                      borderRadius: "4px",
                      marginBottom: "6px",
                      cursor: "pointer",
                      backgroundColor: state.selected === c.id ? "#f0f7ff" : "transparent",
                    }}
                  >
                    <input
                      type="radio"
                      name={`host-${note.id}`}
                      checked={state.selected === c.id}
                      onChange={() => patch(note.id, { selected: c.id, browsing: false })}
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: "14px", wordBreak: "break-word" }}>
                      {c.title}
                    </span>
                    <span style={{ fontSize: "12px", color: "#999", whiteSpace: "nowrap" }}>
                      {hostnameOf(c.source)} · {c.score.toFixed(2)}
                    </span>
                  </label>
                ))}

                {/* 不设自动阈值：评估集 n=10，没有校准阈值的条件。该不该选由本人判断。 */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 10px",
                    border: `1px solid ${state.browsing ? "#ff9800" : "#eee"}`,
                    borderRadius: "4px",
                    cursor: "pointer",
                    backgroundColor: state.browsing ? "#fff8e1" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name={`host-${note.id}`}
                    checked={state.browsing}
                    onChange={() => patch(note.id, { browsing: true, selected: null })}
                  />
                  <span style={{ fontSize: "14px", color: "#666" }}>
                    {state.candidates.length === 0 ? "库里还没有材料" : "都不合适 —— 浏览全部材料"}
                  </span>
                </label>

                {/* 检索把正确宿主排在第 3 名之外是实测发生过的事（速记原文作查询时，
                    正确宿主排第 5 和第 6）。所以必须有一份可浏览的完整列表：
                    「界面必须支持浏览，不能只有搜索」。 */}
                {state.browsing && (
                  <div style={{ marginTop: "10px", border: "1px solid #eee", borderRadius: "4px", padding: "10px" }}>
                    <input
                      value={state.filter}
                      onChange={(e) => patch(note.id, { filter: e.target.value })}
                      placeholder="按标题筛选全部材料"
                      style={{
                        width: "100%",
                        padding: "7px 10px",
                        fontSize: "14px",
                        fontFamily: "inherit",
                        border: "1px solid #ccc",
                        borderRadius: "4px",
                        marginBottom: "8px",
                      }}
                    />
                    <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                      {materials
                        .filter((m) => m.title.toLowerCase().includes(state.filter.trim().toLowerCase()))
                        .map((m) => (
                          <label
                            key={m.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                              padding: "6px 8px",
                              borderRadius: "4px",
                              cursor: "pointer",
                              backgroundColor: state.selected === m.id ? "#f0f7ff" : "transparent",
                            }}
                          >
                            <input
                              type="radio"
                              name={`browse-${note.id}`}
                              checked={state.selected === m.id}
                              onChange={() => patch(note.id, { selected: m.id })}
                            />
                            <span style={{ flex: 1, minWidth: 0, fontSize: "14px", wordBreak: "break-word" }}>
                              {m.title}
                            </span>
                            <span style={{ fontSize: "12px", color: "#aaa", whiteSpace: "nowrap" }}>
                              {hostnameOf(m.source)}
                            </span>
                          </label>
                        ))}
                      {materials.length === 0 && (
                        <div style={{ color: "#999", fontSize: "13px", padding: "6px" }}>库里还没有材料。</div>
                      )}
                    </div>
                  </div>
                )}

                {(state.browsing || state.candidates.length === 0) && (
                  <div
                    style={{
                      marginTop: "10px",
                      padding: "12px",
                      backgroundColor: "#fff8e1",
                      border: "1px solid #ffe0b2",
                      borderRadius: "4px",
                      fontSize: "13px",
                      lineHeight: 1.8,
                      color: "#7a5c00",
                    }}
                  >
                    上面整份列表里也确实没有能支撑这条<strong>速记</strong>的<strong>材料</strong>？
                    那就先去<strong>收录</strong>一篇——<strong>标注</strong>必须有宿主，
                    脱离来源的洞察数月后无法核查。
                    <br />
                    去浏览器打开来源页，<code>Ctrl+D</code> 存进 <code>Zhandao待收录</code>，
                    回「过闸」把它收录进来，这条速记就有宿主了。
                    <br />
                    <span style={{ color: "#a08000" }}>
                      在那之前这条速记留在队列里不动（它还没到两个终态的任何一个）。
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", gap: "10px", marginTop: "14px", alignItems: "center" }}>
                  <button
                    onClick={() => void attach(note)}
                    disabled={!canAttach || state.status === "提交中"}
                    style={{
                      padding: "8px 18px",
                      backgroundColor: canAttach && state.status !== "提交中" ? "#4caf50" : "#ccc",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: canAttach && state.status !== "提交中" ? "pointer" : "not-allowed",
                    }}
                  >
                    {state.status === "提交中" ? "写入中..." : "归属"}
                  </button>
                  <button
                    onClick={() => void drop(note)}
                    disabled={state.status === "提交中"}
                    style={{
                      padding: "8px 18px",
                      backgroundColor: "#f44336",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: state.status === "提交中" ? "not-allowed" : "pointer",
                    }}
                  >
                    丢弃
                  </button>
                  {state.error !== undefined && (
                    <span style={{ color: "#c33", fontSize: "13px" }}>{state.error}</span>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
