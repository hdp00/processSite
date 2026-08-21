import { defineConfig, mergeConfig } from "vitest/config";
import coreConfig from "./vitest.config.ts";

export default mergeConfig(coreConfig, defineConfig({
  test: {
    coverage: {
      reportsDirectory: "./coverage/all-source",
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 20,
      },
    },
  },
}));
