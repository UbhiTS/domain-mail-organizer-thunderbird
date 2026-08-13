import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMessage,
  domainFromEmail,
  fallbackParseMailboxString,
  isRegistrableDomain,
  normalizeDomain,
  normalizeEmail,
  validateFolderName
} from "../extension/lib/rules.js";

function config(customers, overrides = {}) {
  return {customers, scanSubject: true, scanBody: true, ...overrides};
}

function customer(id, domains = [], keywords = [], addresses = [], accountIds = []) {
  return {id, enabled: true, domains, keywords, addresses, accountIds};
}

test("normalizes domains and rejects unsafe or incomplete values", () => {
  assert.equal(normalizeDomain(" @EXAMPLE.COM. "), "example.com");
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
  assert.equal(normalizeDomain("not a domain"), "");
  assert.equal(normalizeDomain("localhost"), "");
  assert.equal(normalizeDomain("example.com/path"), "");
  assert.equal(normalizeDomain("MICROSOFT.COM"), "microsoft.com");
});

test("organization domains are distinguished from public suffixes", () => {
  assert.equal(isRegistrableDomain("hitachi.com"), true);
  assert.equal(isRegistrableDomain("hal.hitachi.com"), true);
  assert.equal(isRegistrableDomain("example.co.uk"), true);
  assert.equal(isRegistrableDomain("co.uk"), false);
  assert.equal(isRegistrableDomain("com.au"), false);
});

test("a legacy public-suffix customer is excluded from classification", () => {
  const legacy = customer("legacy", ["co.uk"]);
  assert.equal(
    classifyMessage(
      {authorEmails: ["person@unrelated-company.co.uk"], recipientEmails: []},
      config([legacy], {scanSubject: false, scanBody: false}),
      "work"
    ).status,
    "unmatched"
  );
});

test("normalizes exact addresses without accepting multiple at signs", () => {
  assert.equal(normalizeEmail(" Person@EXAMPLE.COM "), "person@example.com");
  assert.equal(normalizeEmail("a@b@example.com"), "");
  assert.equal(domainFromEmail("user@acme.com"), "acme.com");
});

test("domain matching is exact and does not include subdomains", () => {
  const rules = config([customer("acme", ["acme.com"])]);
  assert.equal(
    classifyMessage({authorEmails: ["a@acme.com"], recipientEmails: []}, rules, "work").status,
    "matched"
  );
  assert.equal(
    classifyMessage({authorEmails: ["a@notacme.com"], recipientEmails: []}, rules, "work").status,
    "unmatched"
  );
  assert.equal(
    classifyMessage({authorEmails: ["a@sub.acme.com"], recipientEmails: []}, rules, "work").status,
    "unmatched"
  );
});

test("explicit sister-company domains route independently from their parent", () => {
  const rules = config([
    customer("hitachi", ["hitachi.com"]),
    customer("hal", ["hal.hitachi.com"]),
    customer("rail", ["rail.hitachi.com"]),
    customer("cyber", ["cyber.hitachi.com"])
  ]);

  for (const [email, customerId] of [
    ["person@hitachi.com", "hitachi"],
    ["person@hal.hitachi.com", "hal"],
    ["person@rail.hitachi.com", "rail"],
    ["person@cyber.hitachi.com", "cyber"]
  ]) {
    const result = classifyMessage({authorEmails: [email], recipientEmails: []}, rules, "work");
    assert.equal(result.status, "matched", email);
    assert.equal(result.customerId, customerId, email);
  }
  for (const email of [
    "person@portal.hal.hitachi.com",
    "person@unconfigured.hitachi.com"
  ]) {
    const result = classifyMessage({authorEmails: [email], recipientEmails: []}, rules, "work");
    assert.equal(result.status, "unmatched", email);
  }
});

test("different explicitly configured sister companies stay ambiguous within a stage", () => {
  const rules = config([
    customer("hitachi", ["hitachi.com"]),
    customer("rail", ["rail.hitachi.com"]),
    customer("cyber", ["cyber.hitachi.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: ["one@rail.hitachi.com", "two@cyber.hitachi.com"]
  }, rules, "work");

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.customerIds, ["rail", "cyber"]);
});

test("preserves sender, recipient, subject, then body precedence", () => {
  const rules = config([
    customer("sender", ["sender.com"]),
    customer("recipient", ["recipient.com"]),
    customer("subject", ["subject.com"]),
    customer("body", [], ["body project"])
  ]);
  const result = classifyMessage({
    authorEmails: ["a@sender.com"],
    recipientEmails: ["b@recipient.com"],
    subject: "subject.com escalation",
    body: "body project"
  }, rules, "work");
  assert.equal(result.customerId, "sender");
  assert.equal(result.stage, "sender");
});

test("domain matches take precedence over keywords within a text stage", () => {
  const rules = config([
    customer("keyword", [], ["priority"]),
    customer("domain", ["domain.example.com"], [])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: [],
    subject: "Priority issue for domain.example.com"
  }, rules, "work");
  assert.equal(result.customerId, "domain");
});

test("free-text domain matching requires hostname boundaries", () => {
  const rules = config([customer("acme", ["acme.com"])]);
  assert.equal(
    classifyMessage({authorEmails: [], recipientEmails: [], subject: "Update from notacme.com"}, rules, "work").status,
    "unmatched"
  );
  assert.equal(
    classifyMessage({authorEmails: [], recipientEmails: [], subject: "Update from acme.com"}, rules, "work").customerId,
    "acme"
  );
  assert.equal(
    classifyMessage({authorEmails: [], recipientEmails: [], subject: "Update from sub.acme.com"}, rules, "work").status,
    "unmatched"
  );
  assert.equal(
    classifyMessage({authorEmails: [], recipientEmails: [], subject: "Update from acme.com.evil"}, rules, "work").status,
    "unmatched"
  );
});

test("free-text domain matching also requires an exact configured hostname", () => {
  const rules = config([
    customer("hitachi", ["hitachi.com"]),
    customer("rail", ["rail.hitachi.com"])
  ]);

  assert.equal(
    classifyMessage({
      authorEmails: [],
      recipientEmails: [],
      subject: "Escalation for rail.hitachi.com."
    }, rules, "work").customerId,
    "rail"
  );
  assert.equal(
    classifyMessage({
      authorEmails: [],
      recipientEmails: [],
      subject: "Escalation for other.hitachi.com"
    }, rules, "work").status,
    "unmatched"
  );
});

test("ambiguous matches are skipped instead of choosing enumeration order", () => {
  const rules = config([
    customer("one", ["one.example.com"]),
    customer("two", ["two.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: ["a@one.example.com", "b@two.example.com"]
  }, rules, "work");
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.customerIds, ["one", "two"]);
});

test("customer account scope is honored", () => {
  const rules = config([customer("one", ["one.example.com"], [], [], ["account-a"])]);
  assert.equal(
    classifyMessage({authorEmails: ["a@one.example.com"]}, rules, "account-b").status,
    "unmatched"
  );
});

test("fallback mailbox extraction and folder validation are conservative", () => {
  assert.deepEqual(
    fallbackParseMailboxString("Name <A@EXAMPLE.COM>, b@other.example"),
    ["a@example.com", "b@other.example"]
  );
  assert.equal(validateFolderName("Customer / Unsafe"), "folder name cannot contain slashes or control characters.");
  assert.equal(validateFolderName("Customer – Zürich"), "");
});
