// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const distributionUrl =
  "https://github.com/lupomontero/psl/blob/v1.15.0/dist/psl.mjs";
const sourceUrl =
  "https://github.com/lupomontero/psl/blob/v1.15.0/index.js";

async function projectFile(path) {
  return readFile(join(projectRoot, path), "utf8");
}

test("vendored psl provenance and packaged notice stay reviewable", async () => {
  const [distribution, atn, vendor, notice] = await Promise.all([
    readFile(join(projectRoot, "extension", "vendor", "psl.mjs")),
    projectFile("docs/atn-submission.md"),
    projectFile("VENDOR.md"),
    projectFile("NOTICE")
  ]);
  const digest = createHash("sha256").update(distribution).digest("hex");

  assert.equal(
    digest,
    "66463ab217d9ac57174eb89b100058b450588ce6c8da577e6bf41c074d6514b7"
  );
  for (const disclosure of [atn, vendor]) {
    assert.ok(disclosure.includes(distributionUrl));
    assert.ok(disclosure.includes(sourceUrl));
    assert.ok(disclosure.includes(digest));
  }
  assert.doesNotMatch(notice, /VENDOR\.md/u);
  assert.match(notice, /vendor\/PSL-LICENSE\.txt/u);
  assert.match(notice, /Mozilla Public License 2\.0/u);
});

test("privacy disclosure states safety-journal retention and user control", async () => {
  const privacy = await projectFile("PRIVACY.md");
  assert.match(privacy, /manual-review/u);
  assert.match(privacy, /Message-ID header/u);
  assert.match(privacy, /at least 24 hours/u);
  assert.match(privacy, /no in-product command that clears individual safety/u);
  assert.match(privacy, /not proof of sender identity/u);
});

test("user disclosures explain safe existing address-book reuse", async () => {
  const [readme, privacy, manualPlan, atn, settings, settingsScript] = await Promise.all([
    projectFile("README.md"),
    projectFile("PRIVACY.md"),
    projectFile("docs/manual-test-plan.md"),
    projectFile("docs/atn-submission.md"),
    projectFile("extension/options/options.html"),
    projectFile("extension/options/options.js")
  ]);

  for (const disclosure of [readme, privacy, manualPlan, atn]) {
    assert.match(disclosure, /same-name local writable/u);
    assert.match(disclosure, /preserv/u);
    assert.match(disclosure, /remote/u);
    assert.match(disclosure, /read-only/u);
  }
  assert.match(readme, /Multiple same-name books are ambiguous/u);
  assert.match(settings, /reuses one same-name local writable address book/u);
  assert.match(settingsScript, /reuse or create the managed customer address book/u);
  assert.match(settingsScript, /created; \$\{reusedBooks\} reused/u);
});
