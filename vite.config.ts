import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  // 渲染层根目录：三个 HTML 入口都在 src/renderer 下，HTML 内以 /main.tsx、/lyrics-main.tsx、
  // /login-chrome-main.tsx 引用源码
  root: "src/renderer",
  build: {
    // outDir 相对 root 解析，故回退两级落到仓库根下的 out/renderer
    outDir: "../../out/renderer",
    emptyOutDir: true,
    // 三入口显式声明：主窗 index.html、桌面歌词窗 lyrics.html、
    // R25 的登录浮动控件 login-chrome.html（返回 / 主题两个 kind 共用一个入口）
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
        lyrics: fileURLToPath(new URL("./src/renderer/lyrics.html", import.meta.url)),
        loginChrome: fileURLToPath(new URL("./src/renderer/login-chrome.html", import.meta.url)),
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
