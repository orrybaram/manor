import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import renderer from "vite-plugin-electron-renderer";

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["node-pty", "tree-kill"],
              output: {
                format: "cjs",
              },
            },
          },
        },
      },
      {
        entry: "electron/preload.ts",
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              output: {
                format: "cjs",
              },
            },
          },
        },
      },
      {
        // Terminal host daemon — runs as standalone Node.js process
        entry: "electron/terminal-host/index.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["node-pty", "tree-kill", "@xterm/headless", "@xterm/addon-serialize"],
              output: {
                format: "cjs",
                entryFileNames: "terminal-host-index.js",
              },
            },
          },
        },
      },
      {
        // PTY subprocess — one per terminal session
        entry: "electron/terminal-host/pty-subprocess.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["node-pty", "tree-kill"],
              output: {
                format: "cjs",
                entryFileNames: "pty-subprocess.js",
              },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  clearScreen: false,
});
