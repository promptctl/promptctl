import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@main": path.resolve(__dirname, "src/main"),
    },
    // [LAW:one-source-of-truth] @promptctl/pane-terminal is linked via `file:`
    // from a workspace that has its own React 18 installed for tests. Without
    // dedupe, Vite bundles two Reacts — the library's hooks then run against a
    // null dispatcher and every render throws "Cannot read properties of null
    // (reading 'useRef')". Dedupe forces every `react`/`react-dom` import to
    // resolve to promptctl's copy.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
});
