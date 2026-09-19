import { useState, useEffect, useCallback, useRef } from "react";
import { Drill } from "./Drill.js";

/**
 * 预练标签页：独立于「阅读」的完整入口。
 *
 * 为什么需要这个文件（而不是继续用 Read.tsx 里那个「预练」按钮）：
 * Read.tsx 左侧列表的数据源是 `GET /api/materials/pool`——**推送池**，
 * 按定义排除已被**标注**指向的材料。练到一半写了条**标注**，那篇材料立刻
 * 离开推送池、从列表消失，再也进不去继续练（实测反馈：「我标注过的不再显示
 * 了，我找不到继续预练的路子」）。这里改用 `GET /api/drills/status`，
 * 列的是**全部材料**，不受这条过滤影响。
 *
 * 「阅读」列表排除已消化材料是对的、这里不碰它——两个列表的数据源刻意不同。
 */

interface DrillStatusItem {
  materialId: string;
  title: string;
  /** 是否已提取过练题；false 时 total/unknown/unattempted 恒为 0 */
  cached: boolean;
  total: number;
  /** 最新自评「不会」的条数 */
  unknown: number;
  /** 从没练过的条数 */
  unattempted: number;
}

interface MaterialDetail {
  id: string;
  title: string;
  markdown: string;
}

const API = "http://localhost:3001";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// 边界数据：来自我们自己的服务端、读自 data/ 里的材料 + 练题记录，
// 形状扁平，照 CLAUDE.md 的边界表用手写 typeof 收窄（不需要 zod）。
function isDrillStatusItem(v: unknown): v is DrillStatusItem {
  if (!isRecord(v)) return false;
  if (!("materialId" in v) || typeof v.materialId !== "string") return false;
  if (!("title" in v) || typeof v.title !== "string") return false;
  if (!("cached" in v) || typeof v.cached !== "boolean") return false;
  if (!("total" in v) || typeof v.total !== "number") return false;
  if (!("unknown" in v) || typeof v.unknown !== "number") return false;
  if (!("unattempted" in v) || typeof v.unattempted !== "number") return false;
  return true;
}

function parseStatusPayload(payload: unknown): DrillStatusItem[] | null {
  if (!isRecord(payload)) return null;
  if (!("materials" in payload) || !Array.isArray(payload.materials)) return null;
  // 坏条目跳过而不是整页报错，与 Attach.tsx / Drill.tsx 对列表的处理同一个原则
  return payload.materials.filter(isDrillStatusItem);
}

function parseDetail(v: unknown): MaterialDetail | null {
  if (!isRecord(v)) return null;
  const { id, title, markdown } = v;
  if (typeof id !== "string" || typeof title !== "string" || typeof markdown !== "string") return null;
  return { id, title, markdown };
}

function errorMessageOf(body: unknown, status: number): string {
  if (isRecord(body) && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `HTTP ${status}`;
}

function statusLabel(item: DrillStatusItem): string {
  if (!item.cached) return "未提取";
  if (item.total === 0) return "没有练题";
  if (item.unknown === 0 && item.unattempted === 0) return "全标了会";
  return `${item.total} 道 · ${item.unknown} 道不会 · ${item.unattempted} 道没练过`;
}

/**
 * 列表 + 标题筛选，单独成组件、自己管筛选框的 state——照抄 Read.tsx 的
 * NoteEditor / Drill.tsx 的 DrillAnswerEditor 那条原则：打字触发的重渲染
 * 范围锁在这个子树里，不牵连父组件（父组件还管着「要不要重新拉 status」
 * 这类跟筛选无关的状态）。列表本身**不重排**——顺序稳定是它的功能，
 * 筛选框只决定哪些行可见。
 */
function MaterialsBrowser({
  materials,
  onSelect,
}: {
  materials: DrillStatusItem[];
  onSelect: (item: DrillStatusItem) => void;
}) {
  const [filter, setFilter] = useState("");
  const shown = materials.filter((m) => m.title.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="按标题筛选材料"
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: "14px",
          fontFamily: "inherit",
          border: "1px solid #ccc",
          borderRadius: "4px",
          marginBottom: "12px",
          boxSizing: "border-box",
        }}
      />
      {/* contain: paint——列表会长到几百条，把重绘范围锁在这个框里，
          与 Read.tsx 左侧列表 / Attach.tsx 全量材料列表同一个理由。 */}
      <div style={{ contain: "paint" }}>
        {shown.length === 0 && (
          <div style={{ color: "#999", fontSize: "13px", padding: "8px" }}>
            {materials.length === 0 ? "库里还没有材料。" : "没有标题匹配的材料。"}
          </div>
        )}
        {shown.map((m) => {
          // 视觉提示：还有「不会」或「没练过」的练题时给一点强调——
          // 不是排序，只是让「哪些还有东西可练」在扫一眼时能认出来。
          const hasWork = m.unknown + m.unattempted > 0;
          return (
            <button
              key={m.materialId}
              onClick={() => onSelect(m)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                marginBottom: "6px",
                border: "1px solid #eee",
                borderLeft: hasWork ? "4px solid #ff9800" : "4px solid transparent",
                borderRadius: "4px",
                backgroundColor: "white",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1.5,
              }}
            >
              <div style={{ wordBreak: "break-word" }}>{m.title}</div>
              <div
                style={{
                  fontSize: "12px",
                  color: hasWork ? "#c66a00" : "#999",
                  marginTop: "4px",
                  fontWeight: hasWork ? 600 : 400,
                }}
              >
                {statusLabel(m)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Phase =
  | { kind: "loading" }
  | { kind: "load_error"; message: string }
  | { kind: "list"; materials: DrillStatusItem[] }
  | { kind: "session_loading"; title: string }
  | { kind: "session_error"; materialId: string; title: string; message: string }
  | { kind: "session"; materialId: string; title: string; markdown: string };

export function DrillHome({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // 用 ref 而不是把 phase 放进下面那个 effect 的依赖数组：只是想在「切回
  // 这个标签」时读一眼「现在是不是正练到一半」，不想因为 phase 变化
  // （比如揭晓答案、记一次会/不会）反复重新订阅这个 effect。
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const loadStatus = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const res = await fetch(`${API}/api/drills/status`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, res.status));
      const materials = parseStatusPayload(body);
      if (materials === null) {
        setPhase({ kind: "load_error", message: "响应形状不对" });
        return;
      }
      setPhase({ kind: "list", materials });
    } catch (err) {
      setPhase({ kind: "load_error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // 切回本标签时重新拉一次——跟 Attach.tsx 同一个理由：数据可能在别处变了
  // （比如「阅读」里刚给某篇材料写了标注）。但正练到一半时不能刷：
  // 四个标签常驻挂载、只用 display 切换，切走再切回不该打断正在进行的练题。
  useEffect(() => {
    if (!active) return;
    if (phaseRef.current.kind === "session") return;
    void loadStatus();
  }, [active, loadStatus]);

  const enterSession = async (item: DrillStatusItem) => {
    setPhase({ kind: "session_loading", title: item.title });
    try {
      const res = await fetch(`${API}/api/materials/${item.materialId}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(body, res.status));
      const detail = parseDetail(body);
      if (detail === null) throw new Error("材料响应形状不对");
      setPhase({ kind: "session", materialId: detail.id, title: detail.title, markdown: detail.markdown });
    } catch (err) {
      setPhase({
        kind: "session_error",
        materialId: item.materialId,
        title: item.title,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 退出会话回到列表态，并重新拉一次 status——刚练完的计数（不会 / 没练过）
  // 要更新，不然列表显示的还是进入会话之前的旧数字。
  const exitSession = () => {
    void loadStatus();
  };

  if (phase.kind === "loading") {
    return <div style={{ padding: "20px", color: "#666" }}>加载中…</div>;
  }

  if (phase.kind === "load_error") {
    return (
      <div style={{ padding: "20px", color: "#c33" }}>
        错误：{phase.message}
        <div style={{ marginTop: "10px" }}>
          <button
            onClick={() => void loadStatus()}
            style={{ padding: "8px 18px", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "session_loading") {
    return <div style={{ padding: "20px", color: "#666" }}>加载「{phase.title}」…</div>;
  }

  if (phase.kind === "session_error") {
    return (
      <div style={{ padding: "20px", color: "#c33" }}>
        加载「{phase.title}」失败：{phase.message}
        <div style={{ marginTop: "10px", display: "flex", gap: "10px" }}>
          <button
            onClick={() => void enterSession({ materialId: phase.materialId, title: phase.title, cached: false, total: 0, unknown: 0, unattempted: 0 })}
            style={{ padding: "8px 18px", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            重试
          </button>
          <button
            onClick={() => void loadStatus()}
            style={{ padding: "8px 18px", backgroundColor: "#9e9e9e", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            回到列表
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "session") {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "14px" }}>
          <h2 style={{ fontSize: "18px", margin: 0 }}>{phase.title}</h2>
          <button
            onClick={exitSession}
            style={{ padding: "6px 14px", backgroundColor: "#9e9e9e", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "13px" }}
          >
            回到列表
          </button>
        </div>
        <Drill materialId={phase.materialId} markdown={phase.markdown} onExit={exitSession} />
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: "#666", fontSize: "13px", marginBottom: "16px", lineHeight: 1.7 }}>
        列的是库里全部材料，不只是未消化的那些——练到一半写了标注，材料会离开
        「阅读」的推送池，但不该从这里消失。点一篇进入预练。
      </p>
      <MaterialsBrowser materials={phase.materials} onSelect={(item) => void enterSession(item)} />
    </div>
  );
}
