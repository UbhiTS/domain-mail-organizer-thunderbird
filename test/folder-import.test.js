import test from "node:test";
import assert from "node:assert/strict";

import {proposeCustomersFromFolders} from "../extension/lib/folder-import.js";

test("domain-named folders become enabled account-scoped rules", () => {
  const [proposal] = proposeCustomersFromFolders([{name: "Rail.Hitachi.com"}], "work");
  assert.equal(proposal.enabled, true);
  assert.deepEqual(proposal.accountIds, ["work"]);
  assert.deepEqual(proposal.domains, ["rail.hitachi.com"]);
  assert.equal(proposal.folderName, "Rail.Hitachi.com");
  assert.equal(proposal.needsReview, false);
});

test("non-domain folders become disabled matcherless review drafts", () => {
  const [proposal] = proposeCustomersFromFolders([{name: "Acme Projects"}], "work");
  assert.equal(proposal.enabled, false);
  assert.deepEqual(proposal.domains, []);
  assert.equal(proposal.needsReview, true);
});

test("folder proposals dedupe against global, scoped, and disabled rules", () => {
  const proposals = proposeCustomersFromFolders(
    [{name: "Global"}, {name: "Scoped"}, {name: "Disabled"}, {name: "Other account"}],
    "work",
    [
      {folderName: "global", accountIds: [], enabled: true, domains: ["global.example"]},
      {folderName: "SCOPED", accountIds: ["work"], enabled: true, domains: ["scoped.example"]},
      {folderName: "disabled", accountIds: ["work"], enabled: false, domains: []},
      {folderName: "Other Account", accountIds: ["other"], enabled: true, domains: ["other.example"]}
    ]
  );
  assert.deepEqual(proposals.map(item => item.folderName), ["Other account"]);
});

test("an exact active domain conflict imports disabled with a warning", () => {
  const [proposal] = proposeCustomersFromFolders(
    [{name: "acme.com"}],
    "work",
    [{name: "Existing Acme", folderName: "Acme", accountIds: [], enabled: true, domains: ["acme.com"]}]
  );
  assert.equal(proposal.enabled, false);
  assert.equal(proposal.conflictingDomain, "acme.com");
  assert.match(proposal.warning, /already assigned to Existing Acme/u);
});

test("public suffix folder names are never enabled as customer rules", () => {
  const [proposal] = proposeCustomersFromFolders([{name: "co.uk"}], "work");
  assert.equal(proposal.enabled, false);
  assert.deepEqual(proposal.domains, []);
});
