import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = path.join(packageRoot, "src", "generated");
const orvalCli = fileURLToPath(import.meta.resolve("orval/bin/orval"));

const snapshotGeneratedArtifacts = async () => {
  const snapshot = new Map();

  const visit = async (directory) => {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(generatedRoot, absolutePath).replaceAll(path.sep, "/");
      const digest = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
      snapshot.set(relativePath, digest);
    }
  };

  await visit(generatedRoot);
  return snapshot;
};

const before = await snapshotGeneratedArtifacts();
const generation = spawnSync(process.execPath, [orvalCli, "--config", "orval.config.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
  windowsHide: true,
});

if (generation.error) {
  throw generation.error;
}

if (generation.status !== 0) {
  process.exit(generation.status ?? 1);
}

const after = await snapshotGeneratedArtifacts();
const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
const changes = paths.flatMap((relativePath) => {
  if (!before.has(relativePath)) {
    return [`added: ${relativePath}`];
  }

  if (!after.has(relativePath)) {
    return [`removed: ${relativePath}`];
  }

  if (before.get(relativePath) !== after.get(relativePath)) {
    return [`changed: ${relativePath}`];
  }

  return [];
});

if (changes.length > 0) {
  process.stderr.write("OpenAPI generated artifacts are not up to date:\n");
  process.stderr.write(`${changes.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`OpenAPI generated artifacts are up to date (${after.size} files).\n`);
