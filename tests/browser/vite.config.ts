import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Serves fixed correctness and benchmark fixtures without watching output or dependency trees. */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  server: { watch: null, hmr: false },
});
