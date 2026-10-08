import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath, URL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({
      include: ["buffer", "process", "crypto", "stream", "events", "util"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  define: {
    // Node.js globals needed by ethers v6, web3auth, and walletconnect
    "process.env": {},
    "process.browser": true,
    "process.version": JSON.stringify(""),
    global: "globalThis",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@repo": repoRoot,
      // Ensure buffer polyfill resolves for any bare `buffer` import
      buffer: "buffer/",
      // Let browser bundles hit library fallback paths without vm-browserify.
      vm: fileURLToPath(new URL("./src/shims/vm.js", import.meta.url)),
    },
  },
  build: {
    // The identity provider loads on demand; retain a visible warning if that
    // deferred bundle grows beyond its existing size budget.
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (
          warning.code === "INVALID_ANNOTATION" &&
          warning.id?.includes(
            "@walletconnect/utils/node_modules/ox/_esm/core/Base64.js",
          )
        ) {
          return;
        }
        defaultHandler(warning);
      },
      output: {
        // Keep shared dependencies and Vite's preload helper out of deferred
        // identity chunks; otherwise ordinary routes eagerly import that tree.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // vue core
          if (
            id.includes("vue-router") ||
            id.includes("/vue/") ||
            id.includes("/@vue/")
          )
            return "vue-vendor";
          if (id.includes("highlight.js") || id.includes("@highlightjs"))
            return "highlight";
          if (id.includes("katex")) return "katex";
          if (id.includes("vue-toastification")) return "toast";
          if (id.includes("jose")) return "jose";
          // Keep the identity provider and its shared dependencies automatic.
          // Forcing Torus, React or analytics into separate chunks creates
          // initialization cycles or pulls the provider into ordinary routes.
          // Ethers also has internal cycles and must remain automatic.
        },
      },
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
