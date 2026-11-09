import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    start: "src/start.ts",
    "pdf-render.worker": "src/lib/pdf/pdf-render.worker.ts",
  },
  outDir: "dist",
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: false,
  // Generating exports from two entries would replace the "." export that `node apps/live` relies on.
  exports: false,
});
