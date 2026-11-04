import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target: "http://127.0.0.1:4310", changeOrigin: true },
      "/api/auth": { target: "http://127.0.0.1:4310", changeOrigin: true },
      "/source": { target: "http://127.0.0.1:4310", changeOrigin: true },
    },
  },
});
