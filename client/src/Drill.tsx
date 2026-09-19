import { useState, useEffect, useCallback, useMemo } from "react";
import type { ReactElement } from "react";
import { renderBody } from "./renderMarkdown.js";

/**
 * 预练：就一份**材料**里现成的**练题**逐道作答、自评会不会。
 *
 * 与闭环的出题 / 答题是两条链路，共享零个数据结构（ADR-0011）。
 * 这里只负责：取练题清单 → 一次问一道 → 先作答才能揭晓原文 → 记会/不会 → 下一道。
 * 不调模型批改、作答文本不留存、不改孤岛判据、不进推送池——这些都是服务端 /
 * 数据模型的事，前端只是不做任何会暗示这些事发生的 UI（比如不做「批改」按钮）。
 */

interface DrillItem {
  id: string;
  question: string;
  anchor: string;
  /** 0-based，配合 markdown 定位原文，见 sliceByAnchor */
  anchorLine: number;
  /** 上次自评；从没练过是 null */
  lastKnown: boolean | null;
}

const API = "http://localhost:3001";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// 外部数据（服务端 JSON）必须校验，不能断言——照抄 Attach.tsx 的 `in` 收窄风格。
function isDrillItem(v: unknown): v is DrillItem {
  if (!isRecord(v)) return false;
  if (!("id" in v) || typeof v.id !== "string") return false;
  if (!("question" in v) || typeof v.question !== "string") return false;
  if (!("anchor" in v) || typeof v.anchor !== "string") return false;
  if (!("anchorLine" in v) || typeof v.anchorLine !== "number") return false;
  if (!("lastKnown" in v)) return false;
  if (v.lastKnown !== null && typeof v.lastKnown !== "boolean") return false;
  return true;
}

function parseDrillsPayload(payload: unknown): DrillItem[] | null {
  if (!isRecord(payload)) return null;
  if (!("drills" in payload) || !Array.isArray(payload.drills)) return null;
  // 坏条目跳过而不是整批报错，与 Attach.tsx 对速记列表的处理同一个原则
  return payload.drills.filter(isDrillItem);
}

function errorMessageOf(body: unknown, status: number): string {
  if (isRecord(body) && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `HTTP ${status}`;
}

function isDrillExtractFailed(body: unknown): boolean {
  return isRecord(body) && "code" in body && body.code === "drill_extract_failed";
}

/**
 * 从 anchorLine 那一行切到下一个「同级或更高级」标题为止。
 * anchorLine 本身不是标题行时，切到下一个任意标题行为止。
 * 判层级只看行首 `#` 的个数——契约里只给了 anchorLine，没给 anchor 对应的层级，
 * 所以层级得从 markdown 原文自己读出来。
 */
function sliceByAnchor(markdown: string, anchorLine: number): string {
  const lines = markdown.split("\n");
  if (anchorLine < 0 || anchorLine >= lines.length) return "";

  const headingLevel = (line: string): number | null => {
    const m = /^(#{1,6})\s/.exec(line);
    return m === null ? null : m[1].length;
  };

  const startLevel = headingLevel(lines[anchorLine]);
  let end = lines.length;
  for (let i = anchorLine + 1; i < lines.length; i++) {
    const level = headingLevel(lines[i]);
    if (level === null) continue;
    if (startLevel === null || level <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(anchorLine, end).join("\n");
}

type Phase =
  | { kind: "loading" }
  | { kind: "extract_failed" }
  | { kind: "load_error"; message: string }
  | { kind: "ready"; drills: DrillItem[] };

/**
 * 作答框单独成组件、自己管自己的 text / revealed state——照抄 Read.tsx 的
 * NoteEditor：打字不该触发父组件（进而整个练题列表 + 已渲染原文）重渲染。
 * 用 `key={drill.id}` 让父组件在换题时整块重挂载，天然做到「作答框清空」，
 * 不需要额外的清空逻辑。
 */
function DrillAnswerEditor({
  answerBody,
  submitting,
  onResult,
}: {
  answerBody: ReactElement[];
  submitting: boolean;
  onResult: (known: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [revealed, setRevealed] = useState(false);
  const empty = text.trim().length === 0;

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="先写下你的答案——哪怕一行"
        rows={4}
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
      <div style={{ fontSize: "12px", color: "#999", marginTop: "4px" }}>
        不作答的「我会」只是一种感觉——长度不限，一行还是一段你自己定
      </div>

      {!revealed && (
        <button
          onClick={() => setRevealed(true)}
          disabled={empty}
          style={{
            padding: "8px 18px",
            marginTop: "10px",
            backgroundColor: empty ? "#ccc" : "#4caf50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: empty ? "not-allowed" : "pointer",
          }}
        >
          揭晓答案
        </button>
      )}

      {revealed && (
        <>
          {/* 作答内容保持可见（textarea 没被清空/隐藏），原文摘录展开在下方，
              两者对照——这是「先写答案再揭晓」这条约束存在的意义 */}
          <div style={{ borderTop: "1px solid #eee", marginTop: "14px", paddingTop: "12px" }}>
            <div style={{ fontSize: "12px", color: "#667", marginBottom: "6px" }}>原文</div>
            {answerBody}
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button
              onClick={() => onResult(true)}
              disabled={submitting}
              style={{
                padding: "8px 18px",
                backgroundColor: submitting ? "#ccc" : "#4caf50",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              ✓ 我会了
            </button>
            <button
              onClick={() => onResult(false)}
              disabled={submitting}
              style={{
                padding: "8px 18px",
                backgroundColor: submitting ? "#ccc" : "#f44336",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              ✗ 我不会
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Drill({
  materialId,
  markdown,
  onExit,
}: {
  materialId: string;
  markdown: string;
  onExit: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // 「全部」开关：默认只练上次「不会」的 + 从没练过的，这个开关把它切成全部。
  // 必须在默认视图里，不许藏——见 CLAUDE.md「预练链路的实现约束」。
  const [showAll, setShowAll] = useState(false);
  // 本次会话里对某道练题的最新自评，覆盖服务端一开始给的 lastKnown。
  // 不刷新整个 phase.drills 是因为那份列表本来就该是「进入时的快照」。
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [pos, setPos] = useState(0);
  // 本轮（从上次「练到哪算哪」的起点算起）每道题的结果，用来算小结、
  // 也用来算「再练一轮不会的」这一轮该出哪些题。
  const [roundOutcomes, setRoundOutcomes] = useState<Map<string, boolean>>(new Map());
  // 非 null 时用它替代 showAll 过滤逻辑——「再练一轮不会的」按精确的一批 id 出题，
  // 不是按 lastKnown 状态重新过滤（那样会把这一轮刚标会的也算进去）。
  const [forcedQueueIds, setForcedQueueIds] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    setShowAll(false);
    setOverrides(new Map());
    setPos(0);
    setRoundOutcomes(new Map());
    setForcedQueueIds(null);
    setSubmitError(null);
    try {
      const res = await fetch(`${API}/api/materials/${materialId}/drills`);
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) {
        const drills = parseDrillsPayload(body);
        if (drills === null) {
          setPhase({ kind: "load_error", message: "响应形状不对" });
          return;
        }
        setPhase({ kind: "ready", drills });
        return;
      }
      if (res.status === 502 && isDrillExtractFailed(body)) {
        // 提炼失败是「提炼而非生成」这条不变量的必然代价（见 ADR-0011），
        // 不退化成任何别的东西——这是归属链路那条约束的同类应用。
        setPhase({ kind: "extract_failed" });
        return;
      }
      setPhase({ kind: "load_error", message: errorMessageOf(body, res.status) });
    } catch (err) {
      setPhase({ kind: "load_error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [materialId]);

  useEffect(() => {
    void load();
  }, [load]);

  const drills = phase.kind === "ready" ? phase.drills : [];

  // 本轮队列：正常模式下按 showAll + 最新自评过滤；「再练一轮不会的」模式下
  // 按上一轮记录的精确 id 集合出题。
  const queue = useMemo(() => {
    if (forcedQueueIds !== null) {
      const idSet = new Set(forcedQueueIds);
      return drills.filter((d) => idSet.has(d.id));
    }
    return drills.filter((d) => {
      const overridden = overrides.get(d.id);
      const known = overridden !== undefined ? overridden : d.lastKnown;
      return showAll || known !== true;
    });
  }, [drills, showAll, overrides, forcedQueueIds]);

  const current = pos < queue.length ? queue[pos] : null;

  const answerBody = useMemo(() => {
    if (current === null) return [];
    return renderBody(sliceByAnchor(markdown, current.anchorLine));
  }, [current, markdown]);

  const switchToAll = () => {
    setShowAll(true);
    setForcedQueueIds(null);
    setPos(0);
    setRoundOutcomes(new Map());
  };

  const toggleShowAll = () => {
    setShowAll((s) => !s);
    setForcedQueueIds(null);
    setPos(0);
    setRoundOutcomes(new Map());
  };

  const recordResult = async (drill: DrillItem, known: boolean) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API}/api/drills/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drillId: drill.id, materialId, known }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(errorMessageOf(body, res.status));
      }
      setOverrides((prev) => new Map(prev).set(drill.id, known));
      setRoundOutcomes((prev) => new Map(prev).set(drill.id, known));
      setPos((p) => p + 1);
    } catch (err) {
      // 失败不推进：题目还停在原地，作答框（同一个 key）也还在，可以直接重点按钮重试
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const retryUnknown = () => {
    const unknownIds = [...roundOutcomes.entries()].filter(([, known]) => !known).map(([id]) => id);
    setForcedQueueIds(unknownIds);
    setPos(0);
    setRoundOutcomes(new Map());
  };

  if (phase.kind === "loading") {
    return <div style={{ padding: "20px", color: "#666" }}>正在提取练题…（第一次要调模型，可能要几秒）</div>;
  }

  if (phase.kind === "extract_failed") {
    return (
      <div style={{ padding: "20px" }}>
        <div style={{ color: "#c33", marginBottom: "12px" }}>自动提取练题失败</div>
        <button
          onClick={() => void load()}
          style={{ padding: "8px 18px", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
        >
          重试
        </button>
      </div>
    );
  }

  if (phase.kind === "load_error") {
    return (
      <div style={{ padding: "20px", color: "#c33" }}>
        错误：{phase.message}
        <div style={{ marginTop: "10px" }}>
          <button
            onClick={() => void load()}
            style={{ padding: "8px 18px", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (drills.length === 0) {
    return (
      <div style={{ padding: "20px", color: "#666", lineHeight: 1.8 }}>
        这篇材料里没有提取到现成的问题——不是所有材料都有题，这是正常结果。
        <div style={{ marginTop: "12px" }}>
          <button onClick={onExit} style={{ padding: "8px 18px", backgroundColor: "#9e9e9e", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>
            回到阅读
          </button>
        </div>
      </div>
    );
  }

  const known = [...roundOutcomes.values()].filter((v) => v).length;
  const unknownCount = roundOutcomes.size - known;

  return (
    <div>
      {/* 「全部」开关必须在默认视图里，不许藏——它是这一轮唯一能改变出题范围的控件 */}
      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#666", marginBottom: "16px", cursor: "pointer" }}>
        <input type="checkbox" checked={showAll} onChange={toggleShowAll} />
        练全部练题（默认只出上次「不会」的 + 从没练过的）
      </label>

      {queue.length === 0 && (
        <div style={{ color: "#666", lineHeight: 1.8 }}>
          {/* 队列空 = 既没有「不会」的、也没有没练过的，即这篇全被标成了「会」。
              原文案写的是「上次标『不会』的都练完了」，那只说了一半：
              没练过的题也在默认队列里，它们同样清空了才会走到这个分支。 */}
          这篇的练题你全标了「会」。想重练就切到全部。
          <div style={{ marginTop: "12px", display: "flex", gap: "10px" }}>
            <button
              onClick={switchToAll}
              style={{ padding: "8px 18px", backgroundColor: "#007bff", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}
            >
              切到全部
            </button>
            <button onClick={onExit} style={{ padding: "8px 18px", backgroundColor: "#9e9e9e", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>
              回到阅读
            </button>
          </div>
        </div>
      )}

      {queue.length > 0 && current !== null && (
        <div>
          <div style={{ fontSize: "13px", color: "#999", marginBottom: "8px" }}>
            第 {pos + 1} / {queue.length} 题
          </div>
          <div style={{ fontSize: "16px", lineHeight: 1.7, marginBottom: "16px", fontWeight: 600 }}>
            {current.question}
          </div>
          <DrillAnswerEditor
            key={current.id}
            answerBody={answerBody}
            submitting={submitting}
            onResult={(isKnown) => void recordResult(current, isKnown)}
          />
          {submitError !== null && <div style={{ color: "#c33", fontSize: "13px", marginTop: "10px" }}>{submitError}</div>}
        </div>
      )}

      {queue.length > 0 && current === null && (
        <div>
          <div style={{ fontSize: "16px", marginBottom: "12px" }}>
            本轮 {roundOutcomes.size} 道，会 {known} 道、不会 {unknownCount} 道
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={retryUnknown}
              disabled={unknownCount === 0}
              style={{
                padding: "8px 18px",
                backgroundColor: unknownCount === 0 ? "#ccc" : "#673ab7",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: unknownCount === 0 ? "not-allowed" : "pointer",
              }}
            >
              再练一轮不会的
            </button>
            <button onClick={onExit} style={{ padding: "8px 18px", backgroundColor: "#9e9e9e", color: "white", border: "none", borderRadius: "4px", cursor: "pointer" }}>
              回到阅读
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
