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

  assert.match(html, /id="inbox"[^>]*>Process Inbox<\/button>/u);
  assert.match(html, /id="archiveMail"[^>]*>Archive Mails<\/button>/u);
  assert.match(html, /<strong>Customer Contacts List<\/strong>/u);
  assert.match(html, /All dates in the selected customer folder/u);
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

  assert.match(html, /<h2 id="manualToolsTitle">Mail processing tools<\/h2>/u);
  assert.match(html, /id="processEntireInbox"/u);
  assert.match(html, /<strong>Process entire Inbox<\/strong>/u);
  assert.match(html, /id="recoverArchive"/u);
  assert.match(html, /<strong>Recover from Organizer Archive<\/strong>/u);
  assert.match(script, /send\("createAndOpenBulkPlan", \{accountId: elements\.manualAccount\.value\}\)/u);
  assert.match(script, /kind: "organize",\s+source: "archive"/u);
});
