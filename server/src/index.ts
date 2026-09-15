import { createApp } from "./app.js";
import { initializeProxyAgent } from "./runtime.js";

// 在任何网络请求之前初始化代理
initializeProxyAgent();

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
