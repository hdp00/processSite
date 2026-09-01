import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import { createViteConfig } from "./vite.config.ts";

export default mergeConfig(createViteConfig("test"), defineConfig({
  test: {
    environment: "node",
    environmentOptions: {
      jsdom: {
        url: "http://flowpilot.test/flowpilot/",
      },
    },
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "json-summary"],
      reportsDirectory: "./coverage/core",
      include: [
        "src/state/permissionEngine.ts",
        "src/state/processVersionResolver.ts",
        "src/state/rolePermissions.ts",
        "src/state/workflowAccess.ts",
        "src/utils/processDefinitionValidation.ts",
        "src/utils/designerStorage.ts",
      ],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/api/contracts.ts",
        "src/data/types.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 65,
        "src/state/permissionEngine.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        "src/state/processVersionResolver.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        "src/state/rolePermissions.ts": {
          lines: 90,
          functions: 90,
          branches: 75,
        },
        "src/state/workflowAccess.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        "src/utils/processDefinitionValidation.ts": {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        "src/utils/designerStorage.ts": {
          lines: 75,
          functions: 65,
          branches: 45,
        },
      },
    },
  },
}));
