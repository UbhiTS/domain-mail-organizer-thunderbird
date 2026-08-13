import test from "node:test";
import assert from "node:assert/strict";
import {
  approvedInternalDomains,
  createContactVCard,
  emailsFromVCard,
  extractCustomerContacts,
  extractManagedContactCandidates,
  filterCustomerContactCandidates,
  filterInternalContactCandidates,
  internalDomainsFromIdentities,
  normalizeContactCandidates,
  parseMailboxCandidates,
  parseMessageContactCandidates
} from "../extension/lib/contacts.js";

test("parses named mailboxes and nested groups through Thunderbird", async () => {
  const calls = [];
  const api = {
    messengerUtilities: {
      parseMailboxString: async (value, preserveGroups) => {
        calls.push([value, preserveGroups]);
        return [
          {name: "", email: "ALICE@EXAMPLE.COM"},
          {
            name: "Project team",
            group: [
              {name: " Alice Example ", email: "alice@example.com"},
              {
                group: [{name: "Böb", email: "bob@example.com"}]
              }
            ]
          },
          {name: "invalid", email: "not an address"}
        ];
      }
    }
  };

  assert.deepEqual(await parseMailboxCandidates("team", api), [
    {name: "Alice Example", email: "alice@example.com"},
    {name: "Böb", email: "bob@example.com"}
  ]);
  assert.deepEqual(calls, [["team", true]]);
});

test("normalizes and deduplicates candidates while preserving the useful name", () => {
  assert.deepEqual(normalizeContactCandidates([
    {email: " Person@EXAMPLE.COM ", name: ""},
    {email: "person@example.com", name: "  Person\r\nExample  "},
    {email: "invalid", name: "Invalid"}
  ]), [
    {email: "person@example.com", name: "Person Example"}
  ]);
});

test("derives unique exact internal domains from account identities", () => {
  assert.deepEqual(internalDomainsFromIdentities([
    {email: " Ubhi@GOOGLE.COM "},
    "alias@google.com",
    {email: "engineer@corp.google.com"},
    {email: "invalid"},
    {email: "person@co.uk"},
    null
  ]), ["google.com", "corp.google.com"]);
});

test("approves only configured domains represented by current identities", () => {
  assert.deepEqual(approvedInternalDomains(
    [{email: "ubhi@google.com"}, {email: "alias@corp.google.com"}],
    ["GOOGLE.COM", "example.com", "corp.google.com", "google.com"]
  ), ["google.com", "corp.google.com"]);
  assert.deepEqual(approvedInternalDomains([], ["google.com"]), []);
});

test("sanitizes untrusted display names and caps their length", () => {
  const [candidate] = normalizeContactCandidates([{
    email: "person@example.com",
    name: `Safe\u202Eevil\u2066 ${"x".repeat(300)}`
  }]);
  assert.equal(candidate.name.includes("\u202E"), false);
  assert.equal(candidate.name.includes("\u2066"), false);
  assert.equal(candidate.name.length, 200);
});

test("keeps exact customer domains and addresses but excludes own identities", () => {
  const customer = {
    domains: ["example.com", "rail.parent.com"],
    addresses: ["special@outside.com"]
  };
  const result = filterCustomerContactCandidates([
    {name: "Alice", email: "alice@example.com"},
    {name: "Me", email: "ME@example.com"},
    {name: "Subdomain", email: "person@sub.example.com"},
    {name: "Sibling", email: "person@other.parent.com"},
    {name: "Rail", email: "person@rail.parent.com"},
    {name: "Explicit", email: "SPECIAL@OUTSIDE.COM"},
    {name: "Unrelated", email: "person@outside.com"}
  ], customer, ["me@example.com"]);

  assert.deepEqual(result, [
    {name: "Alice", email: "alice@example.com"},
    {name: "Rail", email: "person@rail.parent.com"},
    {name: "Explicit", email: "special@outside.com"}
  ]);
});

test("keeps only exact internal domains and excludes own identities", () => {
  const result = filterInternalContactCandidates([
    {name: "Coworker", email: "coworker@google.com"},
    {name: "Me", email: "UBHI@google.com"},
    {name: "Marketing", email: "mailer@em.google.com"},
    {name: "Other", email: "person@example.com"}
  ], ["@GOOGLE.COM", "co.uk", "invalid"], [{email: "ubhi@google.com"}]);

  assert.deepEqual(result, [
    {name: "Coworker", email: "coworker@google.com"}
  ]);
});

test("parses every address header through one message-level operation", async () => {
  const calls = [];
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => {
        calls.push(value);
        const email = String(value).match(/[\w.+-]+@[\w.-]+/u)?.[0] ?? "";
        return email ? [{name: value.split("<", 1)[0].trim(), email}] : [];
      }
    }
  };

  assert.deepEqual(await parseMessageContactCandidates({
    author: "From <from@example.com>",
    recipients: ["To <to@example.com>"],
    ccList: ["Copy <copy@example.com>"],
    bccList: ["Hidden <hidden@example.com>"]
  }, api), [
    {name: "From", email: "from@example.com"},
    {name: "To", email: "to@example.com"},
    {name: "Copy", email: "copy@example.com"},
    {name: "Hidden", email: "hidden@example.com"}
  ]);
  assert.deepEqual(calls, [
    "From <from@example.com>",
    "To <to@example.com>",
    "Copy <copy@example.com>",
    "Hidden <hidden@example.com>"
  ]);
});

test("partitions contacts after one parse and gives exact internal domains priority", async () => {
  const calls = [];
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => {
        calls.push(value);
        const email = String(value).match(/[\w.+-]+@[\w.-]+/u)?.[0] ?? "";
        return email ? [{name: value.split("<", 1)[0].trim(), email}] : [];
      }
    }
  };
  const result = await extractManagedContactCandidates({
    author: "Employee <employee@google.com>",
    recipients: ["Customer <customer@customer.com>"],
    ccList: ["Me <ubhi@google.com>", "Subdomain <news@em.google.com>"],
    bccList: []
  }, {
    domains: ["google.com", "customer.com"],
    addresses: []
  }, ["google.com"], ["ubhi@google.com"], api);

  assert.deepEqual(result, {
    customer: [{name: "Customer", email: "customer@customer.com"}],
    internal: [{name: "Employee", email: "employee@google.com"}]
  });
  assert.deepEqual(calls, [
    "Employee <employee@google.com>",
    "Customer <customer@customer.com>",
    "Me <ubhi@google.com>",
    "Subdomain <news@em.google.com>"
  ]);
});

test("extracts contacts from every address header for the matched customer", async () => {
  const parsed = new Map([
    ["Sender <sender@customer.com>", [{name: "Sender", email: "sender@customer.com"}]],
    ["To <to@customer.com>", [{name: "To", email: "to@customer.com"}]],
    ["Copy <copy@other.com>", [{name: "Copy", email: "copy@other.com"}]],
    ["Hidden <hidden@customer.com>", [{name: "Hidden", email: "hidden@customer.com"}]]
  ]);
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => parsed.get(value) ?? []
    }
  };
  const contacts = await extractCustomerContacts({
    author: "Sender <sender@customer.com>",
    recipients: ["To <to@customer.com>"],
    ccList: ["Copy <copy@other.com>"],
    bccList: ["Hidden <hidden@customer.com>"]
  }, {
    domains: ["customer.com"],
    addresses: []
  }, ["to@customer.com"], api);

  assert.deepEqual(contacts, [
    {name: "Sender", email: "sender@customer.com"},
    {name: "Hidden", email: "hidden@customer.com"}
  ]);
});

test("creates a minimal vCard 4.0 and escapes text values", () => {
  const vCard = createContactVCard(
    {name: "Ann, Q; Ops\\Desk\r\nInjected", email: "ANN@EXAMPLE.COM"},
    "Acme, Inc; West\\Unit\nTwo"
  );

  assert.equal(vCard, [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:Ann\\, Q\\; Ops\\\\Desk\\nInjected",
    "EMAIL:ann@example.com",
    "ORG:Acme\\, Inc\\; West\\\\Unit\\nTwo",
    "END:VCARD",
    ""
  ].join("\r\n"));
  assert.throws(
    () => createContactVCard({name: "No address", email: "invalid"}),
    /valid contact email/iu
  );
});

test("uses the email as FN when the display name is empty", () => {
  assert.match(
    createContactVCard({name: "", email: "contact@example.com"}, "Customer"),
    /\r\nFN:contact@example\.com\r\n/u
  );
});

test("reads every EMAIL property from folded and grouped vCards", () => {
  const vCard = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "EMAIL;TYPE=work:One@EXAMPLE.COM",
    "item1.EMAIL;TYPE=home:two@exa",
    " mple.com",
    "EMAIL;VALUE=uri:mailto:THREE@example.com",
    "EMAIL:one@example.com",
    "TEL:four@example.com",
    "EMAIL:not-an-email",
    "END:VCARD"
  ].join("\r\n");

  assert.deepEqual(emailsFromVCard(vCard), [
    "one@example.com",
    "two@example.com",
    "three@example.com"
  ]);
  assert.deepEqual(emailsFromVCard(null), []);
});
