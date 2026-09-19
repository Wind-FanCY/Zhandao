import type { ReactElement } from "react";

/**
 * 最小渲染：按 ``` 切开，代码块用等宽 + 底色，正文按原样保留换行，图片折叠成标记。
 *
 * 刻意**不**引入 markdown 渲染库：那是一个依赖决定，该由本人拍。
 * 这个版本把最要紧的区分（代码 vs 正文）做出来了，标题会以 `## ` 原样出现
 * ——看着糙，但那反而让文章结构一眼可见。装了 react-markdown 会好很多。
 *
 * 从 Read.tsx 提出来单独成模块：预练要在原文摘录（一个锚点切出的片段）上
 * 复用同一种渲染方式，不新写一个渲染器——见 CLAUDE.md「预练链路的实现约束」。
 */
export function renderBody(markdown: string): ReactElement[] {
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
