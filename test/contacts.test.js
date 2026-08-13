import test from "node:test";
import assert from "node:assert/strict";
import {
  createContactVCard,
  emailsFromVCard,
  extractCustomerContacts,
  filterCustomerContactCandidates,
  normalizeContactCandidates,
  parseMailboxCandidates
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
