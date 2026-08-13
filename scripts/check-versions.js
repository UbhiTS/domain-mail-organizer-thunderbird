// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function checkVersionConsistency(root = projectRoot) {
  const [packageJson, packageLock, manifest] = await Promise.all([
    readJson(join(root, "package.json")),
    readJson(join(root, "package-lock.json")),
    readJson(join(root, "extension", "manifest.json"))
  ]);
  const versions = new Map([
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ["package-lock.json packages['']", packageLock.packages?.[""]?.version],
    ["extension/manifest.json", manifest.version]
  ]);

  for (const [location, version] of versions) {
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Missing or invalid version in ${location}`);
    }
  }

  const expected = versions.get("package.json");
  if ([...versions.values()].some(version => version !== expected)) {
    const detail = [...versions]
      .map(([location, version]) => `  ${location}: ${JSON.stringify(version)}`)
      .join("\n");
    throw new Error(`Project versions do not agree:\n${detail}`);
  }
  return expected;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  try {
    const version = await checkVersionConsistency();
    console.log(`Version consistency check passed: ${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
