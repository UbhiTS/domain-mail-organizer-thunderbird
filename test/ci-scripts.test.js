// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {checkVersionConsistency} from "../scripts/check-versions.js";
import {
  evaluateLintReport,
  isAllowedThunderbirdWarning
} from "../scripts/lint.js";

async function versionFixture(t, versions) {
  const root = await mkdtemp(join(tmpdir(), "dmo-version-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "extension"));
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({version: versions.package})),
    writeFile(join(root, "package-lock.json"), JSON.stringify({
      version: versions.lock,
      packages: {"": {version: versions.lockRoot}}
    })),
    writeFile(join(root, "extension", "manifest.json"), JSON.stringify({
      version: versions.manifest
    }))
  ]);
  return root;
}

function warning(overrides = {}) {
  return {
    _type: "warning",
    code: "MANIFEST_PERMISSIONS",
    message: "/permissions: Invalid permissions \"accountsRead\" at 0.",
    file: "manifest.json",
    instancePath: "/permissions/0",
    ...overrides
  };
}

function report(overrides = {}) {
  return {errors: [], notices: [], warnings: [], ...overrides};
}

test("version checker accepts matching package, lock, and manifest versions", async t => {
  const root = await versionFixture(t, {
    package: "1.2.3",
    lock: "1.2.3",
    lockRoot: "1.2.3",
    manifest: "1.2.3"
  });
  assert.equal(await checkVersionConsistency(root), "1.2.3");
});

test("version checker reports every version when one differs", async t => {
  const root = await versionFixture(t, {
    package: "1.2.3",
    lock: "1.2.3",
    lockRoot: "1.2.2",
    manifest: "1.2.3"
  });
  await assert.rejects(
    checkVersionConsistency(root),
    error => error.message.includes("package-lock.json packages['']: \"1.2.2\"") &&
      error.message.includes("extension/manifest.json: \"1.2.3\"")
  );
});

test("lint wrapper accepts only the exact known Thunderbird permission warning", () => {
  for (const [index, permission] of [
    "accountsRead",
    "accountsFolders",
    "addressBooks",
    "messagesRead",
    "messagesMove"
  ].entries()) {
    assert.equal(isAllowedThunderbirdWarning(warning({
      instancePath: `/permissions/${index}`,
      message: `/permissions: Invalid permissions "${permission}" at ${index}.`
    })), true);
  }
  assert.equal(isAllowedThunderbirdWarning(warning({file: "background.js"})), false);
  assert.equal(isAllowedThunderbirdWarning(warning({code: "OTHER_WARNING"})), false);
  assert.equal(isAllowedThunderbirdWarning(warning({
    message: "/permissions: Invalid permissions \"history\" at 0."
  })), false);
});

test("lint evaluation fails unexpected warnings and validation errors", () => {
  const allowed = warning();
  assert.equal(evaluateLintReport(report({warnings: [allowed]})).passed, true);

  const unexpected = evaluateLintReport(report({
    errors: [{_type: "error", code: "BAD_MANIFEST", message: "invalid"}],
    warnings: [allowed, warning({file: "other.json"})]
  }));
  assert.equal(unexpected.passed, false);
  assert.deepEqual(unexpected.allowedWarnings, [allowed]);
  assert.equal(unexpected.unexpectedWarnings.length, 1);
  assert.equal(unexpected.errors.length, 1);
});

test("lint evaluation rejects malformed web-ext reports", () => {
  assert.throws(
    () => evaluateLintReport({errors: [], notices: []}),
    /missing the warnings array/
  );
});
