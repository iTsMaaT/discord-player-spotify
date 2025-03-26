import { defineConfig } from "tsup"

export default defineConfig({
    format: ["esm"],
    entry: ['./src/index.ts'],
    outDir: "./dist",
    skipNodeModulesBundle: true,
    dts: true,
});