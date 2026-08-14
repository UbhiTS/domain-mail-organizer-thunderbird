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
  return {id, name: id, enabled: true, domains, keywords, addresses, accountIds};
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

test("the first displayed sister company wins when one address stage matches several", () => {
  const rules = config([
    customer("hitachi", ["hitachi.com"]),
    customer("rail", ["rail.hitachi.com"]),
    customer("cyber", ["cyber.hitachi.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: ["one@rail.hitachi.com", "two@cyber.hitachi.com"]
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "cyber");
  assert.equal(result.stage, "address");
});

test("From, To, and Cc form one address stage ordered like the displayed Customer Rules", () => {
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
  assert.equal(result.customerId, "recipient");
  assert.equal(result.stage, "address");
});

test("subject precedes body after the combined address stage", () => {
  const rules = config([
    customer("body-first-rule", [], ["body project"]),
    customer("subject-later-rule", ["subject.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: [],
    subject: "Escalation for subject.example.com",
    body: "body project"
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "subject-later-rule");
  assert.equal(result.stage, "subject");
});

test("an exact domain is more specific than a keyword in one text stage", () => {
  const rules = config([
    customer("alpha-keyword", [], ["priority"]),
    customer("zeta-domain", ["domain.example.com"], [])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: [],
    subject: "Priority issue for domain.example.com"
  }, rules, "work");
  assert.equal(result.customerId, "zeta-domain");
  assert.equal(result.stage, "subject");
});

test("body also prefers an exact domain over a keyword", () => {
  const rules = config([
    customer("first", [], ["project alpha"]),
    customer("second", ["second.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: [],
    subject: "No customer reference here",
    body: "Project Alpha update from second.example.com"
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "second");
  assert.equal(result.stage, "body");
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

test("displayed Customer Rules order wins independently of storage and address order", () => {
  const rules = config([
    customer("two", ["two.example.com"]),
    customer("one", ["one.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: ["b@two.example.com", "a@one.example.com"]
  }, rules, "work");
  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "one");
  assert.equal(result.stage, "address");
});

test("an exact configured address is more specific than a domain match", () => {
  const rules = config([
    customer("alpha-domain", ["acme.com"]),
    customer("zeta-address", [], [], ["person@acme.com"])
  ]);
  const result = classifyMessage({
    authorEmails: ["person@acme.com"],
    recipientEmails: []
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "zeta-address");
  assert.equal(result.stage, "address");
});

test("address specificity is applied across the combined From, To, and Cc stage", () => {
  const rules = config([
    customer("alpha-sender-domain", ["sender.example.com"]),
    customer("zeta-recipient-address", [], [], ["vip@recipient.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: ["person@sender.example.com"],
    recipientEmails: ["vip@recipient.example.com"]
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "zeta-recipient-address");
  assert.equal(result.stage, "address");
});

test("displayed Customer Rules order wins over storage and domain occurrence order", () => {
  const rules = config([
    customer("zeta", ["zeta.example.com"]),
    customer("alpha", ["alpha.example.com"])
  ]);
  const result = classifyMessage({
    authorEmails: [],
    recipientEmails: [],
    subject: "zeta.example.com depends on alpha.example.com"
  }, rules, "work");

  assert.equal(result.status, "matched");
  assert.equal(result.customerId, "alpha");
  assert.equal(result.stage, "subject");
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
