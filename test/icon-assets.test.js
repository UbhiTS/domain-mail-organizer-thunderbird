// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

async function pngMetadata(relativePath) {
  const bytes = await readFile(new URL(relativePath, projectUrl));
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${relativePath} must have a PNG signature`
  );
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25]
  };
}

test("PNG icon variants have exact RGBA dimensions", async () => {
  assert.deepEqual(await pngMetadata("extension/icons/icon-32.png"), {
    width: 32,
    height: 32,
    bitDepth: 8,
    colorType: 6
  });
  assert.deepEqual(await pngMetadata("extension/icons/icon-64.png"), {
    width: 64,
    height: 64,
    bitDepth: 8,
    colorType: 6
  });
});

test("manifest selects the PNG variants at their native sizes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("extension/manifest.json", projectUrl), "utf8")
  );
  const expected = {
    "16": "icons/icon.svg",
    "32": "icons/icon-32.png",
    "64": "icons/icon-64.png"
  };
  assert.deepEqual(manifest.icons, expected);
  assert.deepEqual(manifest.action.default_icon, expected);
});
