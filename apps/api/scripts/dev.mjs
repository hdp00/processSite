import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const typescriptModule = require.resolve("typescript");
const typescriptCli = resolve(dirname(typescriptModule), "..", "bin", "tsc");

const spawnNode = (arguments_) => spawn(process.execPath, arguments_, {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit"
});

const waitForExit = (child) => new Promise((resolveExit) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolveExit({ code: child.exitCode, signal: child.signalCode });
    return;
  }
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});

const initialBuild = spawnNode([typescriptCli, "-p", "tsconfig.build.json"]);
const initialResult = await waitForExit(initialBuild);
if (initialResult.code !== 0) process.exit(initialResult.code ?? 1);

const compiler = spawnNode([
  typescriptCli,
  "-p",
  "tsconfig.build.json",
  "--watch",
  "--preserveWatchOutput"
]);
const application = spawnNode([
  "--watch",
  "--watch-preserve-output",
  "dist/main.js"
]);

let stopping = false;
const stopChildren = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (compiler.exitCode === null) compiler.kill(signal);
  if (application.exitCode === null) application.kill(signal);
};

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

const firstExit = await Promise.race([
  waitForExit(compiler).then((result) => ({ child: "compiler", ...result })),
  waitForExit(application).then((result) => ({ child: "application", ...result }))
]);
stopChildren();
await Promise.allSettled([waitForExit(compiler), waitForExit(application)]);

if (!stopping || (firstExit.code !== 0 && firstExit.code !== null)) {
  process.exitCode = firstExit.code ?? 1;
}
