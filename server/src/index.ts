import { createApp } from "./app.js";
import { initializeRuntime } from "./runtime.js";

initializeRuntime();


const PORT = parseInt(process.env.PORT ?? "3001", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
