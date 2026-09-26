import { useCallback, useMemo, useState } from "react";
import { renderBody } from "./renderMarkdown.js";

/**
 * 问答视图：一条**自己手写**的 agent 循环，见
 * scratchpad/qa-contract.md（后端契约，本文件只做前端）。
 *
 * 这个页面的核心不是「等答案」，是那份 step 列表——它把循环每一轮
 * 「搜了什么词 / 翻了哪份材料的目录 / 读了哪一节 / 为什么继续或停下」
 * 摊开给人看，跑完之后也保留可见。这是它存在的理由，不是加载动画。
 *
 * SSE 用 fetch + getReader 手动解析（不用 EventSource——它只能 GET，
 * 契约里 POST /api/ask 带 body）。协议是标准 SSE 帧：
 * `event: xxx\ndata: {...}\n\n`，帧之间用两个换行分隔。
 * 必须维护一个跨 chunk 的 buffer——TCP/fetch 的分片边界和 SSE 帧边界
 * 没有任何关系，一个 chunk 可能只带半个帧，也可能一次带好几个帧。
 */

interface AskStep {
  round: number;
  kind: string;
  detail: string;
  summary: string;
}

interface AskCite {
  materialId: string;
  title: string;
}

interface AskDonePayload {
  answer: string | null;
  cites: AskCite[];
  rounds: number;
  hitLimit: boolean;
  found: boolean;
}

interface AskErrorPayload {
  error: string;
}

const API = "http://localhost:3001";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// SSE 载荷是外部数据（来自模型驱动的循环，形状最不可信的一类），
// 一律手写 typeof 收窄，不用 `as` 断言——CLAUDE.md「外部数据必须校验」。
function isAskStep(v: unknown): v is AskStep {
  if (!isRecord(v)) return false;
  if (typeof v.round !== "number") return false;
  if (typeof v.kind !== "string") return false;
  if (typeof v.detail !== "string") return false;
  if (typeof v.summary !== "string") return false;
  return true;
}

function isAskCite(v: unknown): v is AskCite {
  if (!isRecord(v)) return false;
  return typeof v.materialId === "string" && typeof v.title === "string";
}

function isAskDonePayload(v: unknown): v is AskDonePayload {
  if (!isRecord(v)) return false;
  if (v.answer !== null && typeof v.answer !== "string") return false;
  if (!Array.isArray(v.cites) || !v.cites.every(isAskCite)) return false;
  if (typeof v.rounds !== "number") return false;
  if (typeof v.hitLimit !== "boolean") return false;
  if (typeof v.found !== "boolean") return false;
  return true;
}

function isAskErrorPayload(v: unknown): v is AskErrorPayload {
  return isRecord(v) && typeof v.error === "string";
}

function errorMessageOf(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === "string") return body.error;
  return `HTTP ${status}`;
}

/**
 * 把一个完整的 SSE 帧（已经按 `\n\n` 切出来、不含结尾空行）解析成
 * `{event, data}`。`data:` 允许出现多行（SSE 规范允许），按规范应当
 * 用 `\n` 拼接；本项目服务端只会发单行 JSON，这里按规范实现只是不
 * 依赖这条假设。没有 `event:` 行时按 SSE 默认语义算 "message"，
 * 但本契约里三种事件都显式带 event 名，走不到这个默认分支也无妨。
 */
function parseSSEFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "search":
      return "搜索";
    case "outline":
      return "目录";
    case "read":
      return "阅读";
    case "answer":
      return "作答";
    case "none":
      return "库里没有";
    case "protocol_error":
      // 不是「库里没有」——那是关于库的事实，这是关于模型输出的事实。
      // 显示成同一个词会让人以为该去收录一篇，而实际该做的是重问一次。
      return "格式错";
    default:
      // 协议以后可能加新的 kind——不认识的原样显示比藏起来更诚实。
      return kind;
  }
}

type Phase = { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string };

/**
 * 问题输入框单独成组件、自己管自己的 text state——照抄 Read.tsx 的 NoteEditor：
 * 打字不该触发父组件（进而整份 step 列表 + 已渲染的答案正文）重渲染。
 */
function QuestionInput({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (question: string) => void;
}) {
  const [text, setText] = useState("");
  const empty = text.trim().length === 0;

  const submit = () => {
    if (busy || empty) return;
    onSubmit(text);
  };

  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter 提交、Shift+Enter 换行——问答通常是一句话，不需要总去够按钮。
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="问一个库里可能有答案的问题"
        rows={2}
        style={{
          flex: 1,
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
        onClick={submit}
        disabled={busy || empty}
        style={{
          padding: "10px 20px",
          backgroundColor: busy || empty ? "#ccc" : "#007bff",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: busy || empty ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "跑着…" : "提问"}
      </button>
    </div>
  );
}

export function Ask({ onOpenMaterial }: { onOpenMaterial: (materialId: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // 本轮实际提交的问题，独立于输入框的当前文字——提交后输入框会清空，
  // 但页面上方仍要显示「刚才问的是什么」。
  const [question, setQuestion] = useState<string | null>(null);
  const [steps, setSteps] = useState<AskStep[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [cites, setCites] = useState<AskCite[]>([]);
  const [rounds, setRounds] = useState<number | null>(null);
  const [hitLimit, setHitLimit] = useState(false);
  // null = 还没收到 done 事件（本轮还在跑，或者还没问过）
  const [found, setFound] = useState<boolean | null>(null);

  const ask = useCallback(async (rawQuestion: string) => {
    const q = rawQuestion.trim();
    if (q === "") return;

    setPhase({ kind: "running" });
    setQuestion(q);
    setSteps([]);
    setAnswer(null);
    setCites([]);
    setRounds(null);
    setHitLimit(false);
    setFound(null);

    try {
      const res = await fetch(`${API}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(errorMessageOf(body, res.status));
      }
      if (res.body === null) throw new Error("响应没有可读的 body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;

      // 按事件名分派，形状不对的帧直接丢弃——一条脏帧不该打断整条流
      // （模型驱动的循环，step 的 detail/summary 内容本身不可信，
      // 但外层这层 JSON 形状由我们自己的服务端产出，偶发损坏才需要防）。
      const handleFrame = (frame: string) => {
        const parsed = parseSSEFrame(frame);
        if (parsed === null) return;
        let data: unknown;
        try {
          data = JSON.parse(parsed.data);
        } catch {
          return;
        }
        if (parsed.event === "step") {
          if (isAskStep(data)) setSteps((prev) => [...prev, data]);
        } else if (parsed.event === "done") {
          if (isAskDonePayload(data)) {
            setAnswer(data.answer);
            setCites(data.cites);
            setRounds(data.rounds);
            setHitLimit(data.hitLimit);
            setFound(data.found);
            sawDone = true;
          }
        } else if (parsed.event === "error") {
          if (isAskErrorPayload(data)) throw new Error(data.error);
        }
      };

      // 核心：跨 chunk 的半截帧处理。`buffer` 累积所有已到达但未消费的字节，
      // 每次只切出以 `\n\n` 结尾的**完整**帧交给 handleFrame，剩下的半截
      // 留在 buffer 里等下一个 chunk 补完。`{stream: true}` 让 TextDecoder
      // 自己再处理一层字节级别的半截（一个多字节 UTF-8 字符被切在 chunk 边界上）。
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame);
        }
      }
      // 服务端在 done 之后 res.end()，正常情况这里 buffer 应该已经清空；
      // 万一最后一帧没有以 `\n\n` 收尾（连接被截断），把剩下的当最后一帧处理一次。
      if (buffer.trim() !== "") handleFrame(buffer);

      setPhase({ kind: "idle" });
      if (!sawDone) {
        setPhase({ kind: "error", message: "连接中断，没有收到完整结果" });
      }
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // 答案是全文 markdown，渲染一次就够——依赖只有 answer 本身。
  const answerBody = useMemo(() => (answer === null ? null : renderBody(answer)), [answer]);

  const running = phase.kind === "running";
  // "库里没有" 与 hitLimit 触顶都降级为同一个合法终态：`found === false`
  // 或者 `answer === null`（契约允许调用方按任一个判断，这里两个都认）。
  const notFound = found === false || (found === true && answer === null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <QuestionInput busy={running} onSubmit={(q) => void ask(q)} />

      {phase.kind === "error" && (
        <div
          style={{
            padding: "10px 12px",
            backgroundColor: "#fdecea",
            border: "1px solid #f5c6cb",
            borderRadius: "4px",
            color: "#c33",
            fontSize: "13px",
          }}
        >
          错误：{phase.message}
        </div>
      )}

      {question !== null && (
        <div>
          <div style={{ fontSize: "13px", color: "#999", marginBottom: "10px" }}>
            问：{question}
          </div>

          {/* 这份列表是这个页面的主要价值，不是加载动画——跑完之后不收起，
              一直留在原地，让人能回看循环每一轮到底做了什么。 */}
          {steps.length > 0 && (
            <div
              style={{
                border: "1px solid #ddd",
                borderRadius: "4px",
                backgroundColor: "#fafafa",
                padding: "10px 12px",
                marginBottom: "16px",
                fontFamily: "monospace",
                fontSize: "13px",
                lineHeight: 1.9,
              }}
            >
              {steps.map((s, i) => (
                <div key={i}>
                  第 {s.round} 轮 {kindLabel(s.kind)} {s.detail}
                  {s.summary !== "" && <> → {s.summary}</>}
                </div>
              ))}
              {running && <div style={{ color: "#999" }}>…</div>}
            </div>
          )}

          {notFound && (
            <div
              style={{
                padding: "12px 14px",
                backgroundColor: "#fff8e1",
                border: "1px solid #ffe082",
                borderRadius: "4px",
                fontSize: "14px",
                lineHeight: 1.8,
                color: "#795548",
              }}
            >
              库里没有这个问题的答案。
              {hitLimit && <div>循环到达了轮数上限（{rounds} 轮），没能在库里找到出处。</div>}
              <div style={{ marginTop: "6px", fontSize: "13px", color: "#8d6e63" }}>
                这本身是有价值的结果——去「过闸」收一篇（<code>Ctrl+D</code> 进
                「Zhandao待收录」），下次问同一个问题就有答案了。
              </div>
            </div>
          )}

          {answerBody !== null && !notFound && (
            <div>
              <div
                style={{
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  backgroundColor: "white",
                  padding: "16px 18px",
                }}
              >
                {answerBody}
              </div>

              {/* 引用必须可点：点了跳到「阅读」把那篇材料打开——照抄 Root.tsx
                  的标签页状态提升，不新发明一套路由。 */}
              {cites.length > 0 && (
                <div style={{ marginTop: "12px" }}>
                  <div style={{ fontSize: "12px", color: "#667", marginBottom: "6px" }}>
                    引用
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {cites.map((c) => (
                      <button
                        key={c.materialId}
                        onClick={() => onOpenMaterial(c.materialId)}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#f0f7ff",
                          border: "1px solid #cfe3ff",
                          borderRadius: "4px",
                          color: "#007bff",
                          cursor: "pointer",
                          fontSize: "13px",
                        }}
                      >
                        {c.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
