import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild, loadEnv } from "vite";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = resolve(rootDir, "dist");
const mode = process.env.NODE_ENV === "development" ? "development" : "production";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const esbuild = viteRequire("esbuild");

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

const envObject = {
  VITE_WS_URL: wsUrl,
  VITE_ELEVENLABS_AGENT_ID: agentId,
  VITE_MOCK_WS: mockWs,
  MODE: mode,
  DEV: mode !== "production",
  PROD: mode === "production",
};

const esbuildDefine = {
  "import.meta.env.VITE_WS_URL": JSON.stringify(wsUrl),
  "import.meta.env.VITE_ELEVENLABS_AGENT_ID": JSON.stringify(agentId),
  "import.meta.env.VITE_MOCK_WS": JSON.stringify(mockWs),
  "import.meta.env": JSON.stringify(envObject),
};

async function runBuild() {
  // 1. Build sidepanel.html + React/Tailwind UI into dist/
  await viteBuild({
    root: rootDir,
    configFile: resolve(rootDir, "vite.config.ts"),
    mode,
  });

  mkdirSync(distDir, { recursive: true });

  // 2. Bundle background service worker (ESM) and content script (IIFE)
  await Promise.all([
    esbuild.build({
      entryPoints: [resolve(rootDir, "src/background.ts")],
      bundle: true,
      outfile: resolve(distDir, "background.js"),
      format: "esm",
      platform: "browser",
      target: ["chrome120"],
      define: esbuildDefine,
      logLevel: "info",
    }),
    esbuild.build({
      entryPoints: [resolve(rootDir, "src/content.ts")],
      bundle: true,
      outfile: resolve(distDir, "content.js"),
      format: "iife",
      platform: "browser",
      target: ["chrome120"],
      define: esbuildDefine,
      logLevel: "info",
    }),
  ]);

  // 3. Copy MV3 manifest into dist/
  copyFileSync(
    resolve(rootDir, "manifest.json"),
    resolve(distDir, "manifest.json")
  );

  console.log(
    `[dice-extension] Build complete -> dist/ (VITE_MOCK_WS=${mockWs}, VITE_WS_URL=${wsUrl})`
  );
}

runBuild().catch((err) => {
  console.error("[dice-extension] Build failed:", err);
  process.exit(1);
});
