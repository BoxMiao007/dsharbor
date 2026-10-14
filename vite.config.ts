import { defineConfig } from "vite";

// Tauri 开发时从固定端口加载前端（与 src-tauri/tauri.conf.json 的 devUrl 对应）；
// 正式构建产物进 dist/，由外壳打包内嵌。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
