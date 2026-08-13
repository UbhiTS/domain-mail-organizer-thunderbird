// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {inflateRawSync} from "node:zlib";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = join(projectRoot, "extension");
const buildModuleUrl = pathToFileURL(join(projectRoot, "scripts", "build.js")).href;
const manifest = JSON.parse(
  await readFile(join(extensionRoot, "manifest.json"), "utf8")
);
const archiveName = `domain-mail-organizer-${manifest.version}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runBuild(artifacts, timezone) {
  const source = [
    `import {buildExtension} from ${JSON.stringify(buildModuleUrl)};`,
    `await buildExtension({artifacts: ${JSON.stringify(artifacts)}});`
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: projectRoot,
      env: {...process.env, TZ: timezone},
      encoding: "utf8"
    }
  );
  assert.equal(
    result.status,
    0,
    `Build failed in ${timezone}:\n${result.stderr || result.stdout}`
  );
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}

function archiveEntries(archive) {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0
      ? Buffer.from(compressed)
      : method === 8
        ? inflateRawSync(compressed)
        : null;
    assert.ok(content, `Unsupported ZIP compression method ${method} for ${name}`);
    assert.equal(content.length, uncompressedSize, `Wrong size for ${name}`);
    assert.equal(entries.has(name), false, `Duplicate ZIP entry ${name}`);
    entries.set(name, content);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function sourceEntries() {
  const entries = new Map();

  async function visit(directory) {
    const children = await readdir(directory, {withFileTypes: true});
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) await visit(path);
      else {
        entries.set(
          relative(extensionRoot, path).replaceAll("\\", "/"),
          await readFile(path)
        );
      }
    }
  }

  await visit(extensionRoot);
  for (const name of ["LICENSE", "NOTICE"]) {
    entries.set(name, await readFile(join(projectRoot, name)));
  }
  return entries;
}

function assertEntryMapsEqual(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [name, content] of expected) {
    assert.deepEqual(actual.get(name), content, `Content mismatch for ${name}`);
  }
}

test("build archives are byte-reproducible across host timezones", async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dmo-build-test-"));
  t.after(() => rm(temporaryRoot, {recursive: true, force: true}));

  const utcArtifacts = join(temporaryRoot, "utc");
  const pacificArtifacts = join(temporaryRoot, "pacific");
  runBuild(utcArtifacts, "UTC");
  runBuild(pacificArtifacts, "America/Los_Angeles");

  const utcXpi = await readFile(join(utcArtifacts, `${archiveName}.xpi`));
  const utcZip = await readFile(join(utcArtifacts, `${archiveName}.zip`));
  const pacificXpi = await readFile(join(pacificArtifacts, `${archiveName}.xpi`));
  const pacificZip = await readFile(join(pacificArtifacts, `${archiveName}.zip`));

  assert.deepEqual(utcXpi, pacificXpi);
  assert.deepEqual(utcZip, pacificZip);
  assert.equal(sha256(utcXpi), sha256(pacificXpi));
  assert.equal(sha256(utcZip), sha256(pacificZip));
  assert.deepEqual(utcXpi, utcZip);
  assert.deepEqual(pacificXpi, pacificZip);

  const expected = await sourceEntries();
  assertEntryMapsEqual(archiveEntries(utcXpi), expected);
  assertEntryMapsEqual(archiveEntries(pacificXpi), expected);
});
