import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const apiPort = Number(process.env.FLOWPILOT_TEST_API_PORT ?? 3100);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  throw new Error("FLOWPILOT_TEST_API_PORT 必须是有效端口号。");
}

const usesManagedServers = !process.env.FLOWPILOT_TEST_BASE_URL;
const databaseSuffix = `PlaywrightTests_${apiPort}`;
const attachmentRoot = resolve("test-results", `e2e-attachments-${apiPort}`);
const toolDll = resolve(
  "../api/tools/FlowPilot.DatabaseTool/artifacts/e2e/FlowPilot.DatabaseTool.dll",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }

  return result;
}

function runDatabaseCommand(command) {
  return run("dotnet", [
    toolDll,
    command,
    `--FlowPilot:BrowserTests:DatabaseSuffix=${databaseSuffix}`,
  ]);
}

function cleanupAttachments() {
  const expectedParent = resolve("test-results");
  if (!attachmentRoot.startsWith(`${expectedParent}\\`) &&
      !attachmentRoot.startsWith(`${expectedParent}/`)) {
    throw new Error("拒绝清理测试结果目录以外的附件路径。");
  }

  rmSync(attachmentRoot, { recursive: true, force: true });
}

const playwrightCli = resolve("node_modules", "@playwright", "test", "cli.js");
let exitCode = 0;

if (!usesManagedServers) {
  const result = run(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)]);
  process.exit(result.status ?? 1);
}

cleanupAttachments();
const prepare = runDatabaseCommand("prepare-browser-tests");
if (prepare.status !== 0) {
  process.exit(prepare.status ?? 1);
}

try {
  const result = run(
    process.execPath,
    [playwrightCli, "test", ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        FlowPilot__BrowserTests__DatabaseSuffix: databaseSuffix,
        FlowPilot__Attachments__RootDirectory: attachmentRoot,
      },
    },
  );
  exitCode = result.status ?? 1;
} finally {
  const cleanup = runDatabaseCommand("cleanup-browser-tests");
  cleanupAttachments();
  if (exitCode === 0 && cleanup.status !== 0) {
    exitCode = cleanup.status ?? 1;
  }
}

process.exit(exitCode);
