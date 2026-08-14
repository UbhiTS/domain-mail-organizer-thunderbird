// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Settings exposes explicit per-account internal coworker capture", () => {
  const html = source("extension/options/options.html");
  const script = source("extension/options/options.js");
  const styles = source("extension/options/options.css");

  assert.match(html, /class="internal-domain-options"/u);
  assert.match(html, /Capture internal coworkers from customer mail/u);
  assert.match(script, /internalDomainsFromIdentities\(account\.identities\)/u);
  assert.match(script, /checkbox\.className = "capture-internal-domain"/u);
  assert.match(script, /checkbox\.checked = !value\.initialized \|\| savedSet\.has\(domain\)/u);
  assert.match(script, /autoFile\.checked = value\.autoFileRequested !== false/u);
  assert.match(script, /next\.accounts\[card\.dataset\.accountId\] = \{\s+initialized: true,/u);
  assert.match(script, /Your own identity addresses are excluded/u);
  assert.match(script, /shared consumer domain and may add unrelated people/u);
  assert.match(script, /internalContactDomains\s*\n\s*\};/u);
  assert.match(
    styles,
    /\.internal-domain-options\s*\{[^}]*padding-inline-start:\s*32px/u
  );
  assert.match(
    styles,
    /@media \(max-width: 800px\)[\s\S]*\.internal-domain-options\s*\{[^}]*padding-inline-start:\s*28px/u
  );
});
