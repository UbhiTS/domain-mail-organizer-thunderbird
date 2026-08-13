// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import yazl from "yazl";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = join(projectRoot, "extension");
const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
const artifacts = join(projectRoot, "artifacts");
const outputs = ["xpi", "zip"].map((extension) =>
  join(artifacts, `domain-mail-organizer-${manifest.version}.${extension}`)
);

async function filesUnder(directory) {
  const files = [];
  const entries = await readdir(directory, {withFileTypes: true});
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

await mkdir(artifacts, {recursive: true});
await Promise.all(outputs.map((output) => rm(output, {force: true})));
const zip = new yazl.ZipFile();
for (const file of await filesUnder(extensionRoot)) {
  zip.addFile(file, relative(extensionRoot, file).replaceAll("\\", "/"), {
    mtime: new Date("2026-01-01T00:00:00Z"),
    mode: 0o100644
  });
}
for (const name of ["LICENSE", "NOTICE"]) {
  zip.addFile(join(projectRoot, name), name, {
    mtime: new Date("2026-01-01T00:00:00Z"),
    mode: 0o100644
  });
}
zip.end();
const chunks = [];
for await (const chunk of zip.outputStream) chunks.push(chunk);
const archive = Buffer.concat(chunks);
await Promise.all(outputs.map((output) => writeFile(output, archive)));
for (const output of outputs) console.log(relative(projectRoot, output));
