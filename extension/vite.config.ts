import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, rootDir, "VITE_");
  const wsUrl =
    process.env.VITE_WS_URL ??
    loaded.VITE_WS_URL ??
    "ws://localhost:8000/ws/demo1";
  const agentId =
    process.env.VITE_ELEVENLABS_AGENT_ID ??
    loaded.VITE_ELEVENLABS_AGENT_ID ??
    "";
  const mockWs = process.env.VITE_MOCK_WS ?? loaded.VITE_MOCK_WS ?? "false";

  return {
    base: "./",
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(wsUrl),
      "import.meta.env.VITE_ELEVENLABS_AGENT_ID": JSON.stringify(agentId),
      "import.meta.env.VITE_MOCK_WS": JSON.stringify(mockWs),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          sidepanel: resolve(rootDir, "sidepanel.html"),
        },
      },
    },
  };
});
