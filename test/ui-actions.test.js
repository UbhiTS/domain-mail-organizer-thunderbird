// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("toolbar popup exposes the concise processing actions", () => {
  const html = source("extension/popup/popup.html");
  const script = source("extension/popup/popup.js");
  const styles = source("extension/popup/popup.css");

  assert.match(html, /id="inbox"[^>]*>Process Inbox<\/button>/u);
  assert.match(html, /id="archiveMail"[^>]*>Archive Mails<\/button>/u);
  assert.match(html, /<strong>Customer Contacts List<\/strong>/u);
  assert.match(html, /All dates in the selected customer folder/u);
  assert.match(html, /<main id="organizerControls" hidden>/u);
  assert.match(html, /id="bootstrapError"[^>]*role="alert"/u);
  assert.match(
    script,
    /hasInitializedAvailableAccount\(\s+bootstrap\.config,\s+bootstrap\.accounts\s+\);[\s\S]*?organizerControls\.hidden = !initialized;[\s\S]*?if \(!initialized\) return;/u
  );
  assert.match(
    script,
    /catch \(error\) \{[\s\S]*?bootstrapError\.textContent = error\.message;[\s\S]*?bootstrapError\.classList\.remove\("hidden"\);/u
  );
  assert.doesNotMatch(styles, /body\s*\{[^}]*min-height:/u);
  assert.match(
    styles,
    /#status:not\(:empty\)\s*\{[^}]*min-height:\s*22px;[^}]*margin-top:\s*12px;/u
  );
  assert.doesNotMatch(styles, /#status:empty\s*\{[^}]*display:\s*none;/u);
  assert.doesNotMatch(html, /id="bulkInbox"/u);
  assert.doesNotMatch(html, /id="archive"/u);
  assert.match(
    script,
    /elements\.addresses\.addEventListener\("click", \(\) => createAndOpenPlan\("addresses", "current", true\)\)/u
  );
});

test("Settings owns entire-Inbox processing and archive recovery", () => {
  const html = source("extension/options/options.html");
  const script = source("extension/options/options.js");

  assert.match(html, /<h2 id="manualToolsTitle">Mail processing<\/h2>/u);
  assert.match(html, /id="processEntireInbox"/u);
  assert.match(html, /<strong>Process entire Inbox<\/strong>/u);
  assert.match(html, /id="recoverArchive"/u);
  assert.match(html, /<strong>Recover from Archive<\/strong>/u);
  assert.match(script, /send\("createAndOpenBulkPlan", \{accountId: elements\.manualAccount\.value\}\)/u);
  assert.match(script, /kind: "organize",\s+source: "archive"/u);
});

test("Settings presents accounts, combined processing, then customer rules", () => {
  const html = source("extension/options/options.html");
  const script = source("extension/options/options.js");

  const accountsIndex = html.indexOf('id="mailAccountsPanel"');
  const processingIndex = html.indexOf('id="manualToolsPanel"');
  const customersIndex = html.indexOf('id="customerRulesPanel"');
  assert.ok(accountsIndex >= 0 && accountsIndex < processingIndex);
  assert.ok(processingIndex < customersIndex);
  assert.match(html, /<h3 id="processingDefaultsTitle">Processing defaults<\/h3>/u);
  assert.match(html, /<h3 id="processingToolsTitle">Mailbox tools<\/h3>/u);
  assert.doesNotMatch(html, /Safe by default/u);
  assert.match(html, /<span>Domain root folder<\/span>/u);
  assert.match(html, /placeholder="Domains"/u);
  assert.match(html, /placeholder="Archive"/u);
  assert.doesNotMatch(html, /class="adopt-(?:root|archive)"/u);
  assert.doesNotMatch(script, /collectFolderApprovals/u);
  assert.doesNotMatch(html, /id="setupFolders"/u);
  assert.match(html, /id="save"[^>]*>Save &amp; set up<\/button>/u);
  assert.match(script, /const setup = await send\("setupFolders"\);[\s\S]*?config = setup\.config;[\s\S]*?render\(\);/u);
  assert.match(script, /if \(quiet && setupErrors\.length\)[\s\S]*?setup needs attention/u);
});

test("Settings rejects oversized JSON before reading or parsing it", () => {
  const script = source("extension/options/options.js");
  const sizeCheck = script.indexOf("assertSettingsImportFileSize(file)");
  const fileRead = script.indexOf("await file.text()");
  assert.ok(sizeCheck >= 0);
  assert.ok(fileRead > sizeCheck);
});
