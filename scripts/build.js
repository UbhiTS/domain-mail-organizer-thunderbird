// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {join, relative, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import yazl from "yazl";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = join(projectRoot, "extension");
const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));

// ZIP's required DOS timestamp has no timezone and yazl derives it from the
// host's local clock. Use the same local wall-clock value everywhere and omit
// the optional UTC timestamp, whose epoch would otherwise vary by host zone.
const FIXED_ZIP_MTIME = new Date(2026, 0, 1, 0, 0, 0);
const FIXED_ENTRY_OPTIONS = Object.freeze({
  mtime: FIXED_ZIP_MTIME,
  mode: 0o100644,
  forceDosTimestamp: true
});

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

export async function buildExtension({artifacts = join(projectRoot, "artifacts")} = {}) {
  const outputs = ["xpi", "zip"].map((extension) =>
    join(artifacts, `domain-mail-organizer-${manifest.version}.${extension}`)
  );

  await mkdir(artifacts, {recursive: true});
  await Promise.all(outputs.map((output) => rm(output, {force: true})));
  const zip = new yazl.ZipFile();
  for (const file of await filesUnder(extensionRoot)) {
    zip.addFile(
      file,
      relative(extensionRoot, file).replaceAll("\\", "/"),
      FIXED_ENTRY_OPTIONS
    );
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    zip.addFile(join(projectRoot, name), name, FIXED_ENTRY_OPTIONS);
  }
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  await Promise.all(outputs.map((output) => writeFile(output, archive)));
  return outputs;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  for (const output of await buildExtension()) {
    console.log(relative(projectRoot, output));
  }
}
