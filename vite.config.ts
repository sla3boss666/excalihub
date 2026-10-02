import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content: resolve(__dirname, "src/content.ts"),
        bridge: resolve(__dirname, "src/bridge.ts"),
        // Rendu LaTeX (MathJax), importé à la demande par content.js
        latex: resolve(__dirname, "src/latex.ts"),
        // Service worker (connexion Microsoft, OneDrive) et fenêtre de choix du dossier
        background: resolve(__dirname, "src/background.ts"),
        picker: resolve(__dirname, "src/picker.ts"),
      },
      // Garder les exports de latex.js (import dynamique)
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
