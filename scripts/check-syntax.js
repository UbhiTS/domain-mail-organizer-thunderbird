// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {readdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {extname, join} from "node:path";

async function findJavaScript(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJavaScript(path));
    } else if (extname(entry.name) === ".js") {
      files.push(path);
    }
  }
  return files;
}

for (const file of await findJavaScript("extension")) {
  const result = spawnSync(process.execPath, ["--check", file], {stdio: "inherit"});
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
