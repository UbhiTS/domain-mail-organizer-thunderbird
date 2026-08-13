// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {spawnSync} from "node:child_process";
import {join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const allowedWarnings = new Map([
  ["/permissions/0", "accountsRead"],
  ["/permissions/1", "accountsFolders"],
  ["/permissions/2", "addressBooks"],
  ["/permissions/3", "messagesRead"],
  ["/permissions/4", "messagesMove"]
]);

export function isAllowedThunderbirdWarning(warning) {
  const permission = allowedWarnings.get(warning?.instancePath);
  if (!permission) return false;
  const index = warning.instancePath.slice("/permissions/".length);
  return warning._type === "warning" &&
    warning.code === "MANIFEST_PERMISSIONS" &&
    warning.file === "manifest.json" &&
    warning.message ===
      `/permissions: Invalid permissions "${permission}" at ${index}.`;
}

export function evaluateLintReport(report) {
  if (!report || typeof report !== "object") {
    throw new TypeError("web-ext returned a non-object JSON report");
  }
  for (const name of ["errors", "notices", "warnings"]) {
    if (!Array.isArray(report[name])) {
      throw new TypeError(`web-ext JSON report is missing the ${name} array`);
    }
  }
  const allowed = report.warnings.filter(isAllowedThunderbirdWarning);
  const unexpected = report.warnings.filter(
    warning => !isAllowedThunderbirdWarning(warning)
  );
  return {
    allowedWarnings: allowed,
    unexpectedWarnings: unexpected,
    errors: report.errors,
    notices: report.notices,
    passed: report.errors.length === 0 && unexpected.length === 0
  };
}

function formatFinding(finding) {
  const code = finding.code ? ` ${finding.code}` : "";
  const file = finding.file ? ` (${finding.file})` : "";
  return `${finding._type ?? "finding"}${code}${file}: ${finding.message ?? ""}`;
}

export function runLint({root = projectRoot} = {}) {
  const webExtCli = join(root, "node_modules", "web-ext", "bin", "web-ext.js");
  const result = spawnSync(process.execPath, [
    webExtCli,
    "lint",
    "--source-dir", join(root, "extension"),
    "--output", "json",
    "--no-input",
    "--no-config-discovery",
    "--boring"
  ], {
    cwd: root,
    encoding: "utf8",
    env: {...process.env, NO_UPDATE_NOTIFIER: "1"},
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    const detail = result.stdout.trim() || result.stderr.trim() || "no output";
    throw new Error(`Could not parse web-ext JSON output: ${detail}`, {cause: error});
  }
  const evaluation = evaluateLintReport(report);
  const summary = report.summary ?? {};
  console.log(
    `web-ext lint: ${summary.errors ?? report.errors.length} errors, ` +
    `${summary.notices ?? report.notices.length} notices, ` +
    `${summary.warnings ?? report.warnings.length} warnings ` +
    `(${evaluation.allowedWarnings.length} allowed Thunderbird warnings)`
  );
  for (const notice of evaluation.notices) {
    console.log(formatFinding(notice));
  }
  for (const finding of [...evaluation.errors, ...evaluation.unexpectedWarnings]) {
    console.error(formatFinding(finding));
  }
  if (result.stderr.trim()) console.error(result.stderr.trim());

  if (result.status !== 0 || !evaluation.passed) {
    process.exitCode = result.status || 1;
    return false;
  }
  return true;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  try {
    runLint();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
