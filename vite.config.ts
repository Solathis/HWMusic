import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // 渲染层根目录：两个 HTML 入口都在 src/renderer 下，HTML 内以 /main.tsx、/lyrics-main.tsx 引用源码
  root: "src/renderer",
  build: {
    // outDir 相对 root 解析，故回退两级落到仓库根下的 out/renderer
    outDir: "../../out/renderer",
    emptyOutDir: true,
    // 双入口显式声明：主窗 index.html、桌面歌词窗 lyrics.html
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
        lyrics: fileURLToPath(new URL("./src/renderer/lyrics.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
})
