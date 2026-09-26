import { useState, useCallback } from "react";
import { App } from "./App.js";
import { Attach } from "./Attach.js";
import { Read } from "./Read.js";
import { DrillHome } from "./DrillHome.js";
import { Ask } from "./Ask.js";

type View = "阅读" | "过闸" | "归属" | "预练" | "问答";

/**
 * 顶层视图切换。
 *
 * 两个视图都常驻挂载、用 display 隐藏，不做条件渲染：过闸视图持有一条 SSE 连接和
 * 一批抓取进度，切走再切回若重新挂载就全丢了，而重抓可能触发限流。
 *
 * 「归属」标签上的待办计数是这个库的读路径之一：召回靠认出来，
 * 队列静默增长正是 ADR-0009 点名的失效模式，所以它必须一直看得见。
 */
export function Root() {
  // 默认落在「阅读」：推送循环的日常动作在这儿，而**收录**（要先去浏览器加书签）
  // 和**归属**（要先有速记）都是间歇性的。
  const [view, setView] = useState<View>("阅读");
  const [pending, setPending] = useState<number | null>(null);
  // 「问答」里点一条引用要跳到「阅读」把那篇材料打开。这是这两个视图之间
  // 唯一的耦合——没有为此另起一套路由，就是把「跳去哪」提升到共同的父组件，
  // 由 Read 消费之后自己复位（见 Read.tsx 的 jumpToMaterialId 注释）。
  const [jumpToMaterialId, setJumpToMaterialId] = useState<string | null>(null);

  // 必须 memo：Attach 的加载 effect 依赖这个回调，每次渲染换一个新函数会导致
  // 「回调变 → 重新拉取 → setState → 重新渲染」的死循环。
  const handlePendingCount = useCallback((n: number) => setPending(n), []);

  const openInRead = useCallback((materialId: string) => {
    setJumpToMaterialId(materialId);
    setView("阅读");
  }, []);

  const tab = (name: View, badge?: number | null) => (
    <button
      key={name}
      onClick={() => setView(name)}
      style={{
        padding: "8px 18px",
        border: "none",
        borderBottom: view === name ? "2px solid #007bff" : "2px solid transparent",
        backgroundColor: "transparent",
        color: view === name ? "#007bff" : "#666",
        fontWeight: view === name ? 600 : 400,
        cursor: "pointer",
        fontSize: "15px",
      }}
    >
      {name}
      {badge !== null && badge !== undefined && badge > 0 && (
        <span
          style={{
            marginLeft: "8px",
            padding: "1px 7px",
            borderRadius: "10px",
            backgroundColor: "#ff9800",
            color: "white",
            fontSize: "12px",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );

  return (
    // 应用外壳：整体锁在视口高度，让每个视图自己滚。
    // 原先是文档整体滚动，于是读一篇长文时页面高达 39332px——一往下滚，
    // 左边那个可浏览列表就滚出视野了，而它正是 CLAUDE.md 要求的读路径。
    <div style={{ maxWidth: "1200px", margin: "0 auto", height: "calc(100vh - 40px)" /* 减掉 index.css 里 #root 的上下 padding */, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid #ddd", marginBottom: "20px", flexShrink: 0 }}>
        {tab("阅读")}
        {tab("过闸")}
        {tab("归属", pending)}
        {tab("预练")}
        {tab("问答")}
      </div>

      {/* 「阅读」刻意不带数字徽标：待处理几十篇这个数字每天糊在眼前，
          就是开放项里那条「不会每次打开都像在骂自己」要避免的东西。 */}
      <div
        style={{
          display: view === "阅读" ? "flex" : "none",
          flexDirection: "column",
          padding: "0 20px",
          flex: 1,
          minHeight: 0,
        }}
      >
        <h1 style={{ marginBottom: "6px", flexShrink: 0 }}>Zhandao 阅读</h1>
        <p style={{ color: "#666", fontSize: "13px", marginBottom: "16px", lineHeight: 1.7, flexShrink: 0 }}>
          读一篇<strong>材料</strong>，然后走三个终态之一：写<strong>标注</strong>、
          <strong>留档</strong>（读完没什么可写）、或划掉。
        </p>
        <Read
          active={view === "阅读"}
          jumpToMaterialId={jumpToMaterialId}
          onJumpHandled={() => setJumpToMaterialId(null)}
        />
      </div>

      <div style={{ display: view === "过闸" ? "block" : "none", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <App />
      </div>
      <div style={{ display: view === "归属" ? "block" : "none", padding: "0 20px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <h1 style={{ marginBottom: "6px" }}>Zhandao 归属</h1>
        <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px", lineHeight: 1.7 }}>
          把一条<strong>速记</strong>挂到某份<strong>材料</strong>上，它就成了一条<strong>标注</strong>。
          候选是 BM25 直出的前三个，不调模型。
        </p>
        <Attach active={view === "归属"} onPendingCount={handlePendingCount} />
      </div>
      <div style={{ display: view === "预练" ? "block" : "none", padding: "0 20px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <h1 style={{ marginBottom: "6px" }}>Zhandao 预练</h1>
        <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px", lineHeight: 1.7 }}>
          考前工具，与闭环的出题 / 答题是两条链路：就一份<strong>材料</strong>里现成的
          <strong>练题</strong>逐道作答、自评会不会，不进推送池、不改<strong>孤岛</strong>判据。
        </p>
        <DrillHome active={view === "预练"} />
      </div>
      <div style={{ display: view === "问答" ? "block" : "none", padding: "0 20px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <h1 style={{ marginBottom: "6px" }}>Zhandao 问答</h1>
        <p style={{ color: "#666", fontSize: "13px", marginBottom: "20px", lineHeight: 1.7 }}>
          一条自己手写的 agent 循环：搜索 / 翻目录 / 读一节，只用库里已有的
          <strong>材料</strong>作答，答不出就诚实说没有——「库里没有」是合法结果，
          不是失败。
        </p>
        <Ask onOpenMaterial={openInRead} />
      </div>
    </div>
  );
}
