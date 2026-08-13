import test from "node:test";
import assert from "node:assert/strict";

import {
  importExistingCustomerContacts,
  scanExistingCustomerContacts
} from "../extension/lib/contact-backfill.js";
import {managedContactBookName} from "../extension/lib/contact-book.js";

const account = {
  id: "work",
  name: "Work",
  identities: [
    {email: "me@acme.example"},
    {email: "alias@acme.example"}
  ],
  rootFolder: {id: "account-root", accountId: "work", name: "Work", isRoot: true}
};

function customer(overrides = {}) {
  return {
    id: "acme",
    name: "Acme",
    folderName: "Acme",
    enabled: true,
    accountIds: [],
    domains: ["acme.example"],
    addresses: [],
    keywords: [],
    ...overrides
  };
}

function config(customers = [customer()], accountOverrides = {}) {
  return {
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: true,
        ...accountOverrides
      }
    },
    customers
  };
}

function message(id, overrides = {}) {
  return {
    id,
    author: "Alice <alice@acme.example>",
    recipients: [],
    ccList: [],
    bccList: [],
    subject: "Body-looking address body-only@acme.example must not be read",
    ...overrides
  };
}

function parseMailboxes(value) {
  const entries = [];
  const pattern = /(?:(.*)\s*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+)>?/giu;
  for (const match of String(value).matchAll(pattern)) {
    entries.push({name: String(match[1] ?? "").trim(), email: match[2]});
  }
  return entries;
}

function scanApi({folders = {}, pages = {}, onQuery = () => {}} = {}) {
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: []
  };
  const children = Object.values(folders);
  return {
    folders: {
      getSubFolders: async folderId => {
        if (folderId === account.rootFolder.id) return [customerRoot];
        if (folderId === customerRoot.id) return children;
        return [];
      },
      getFolderCapabilities: async () => ({canAddMessages: true}),
      create: async () => assert.fail("backfill must not create a folder"),
      update: async () => assert.fail("backfill must not update a folder"),
      delete: async () => assert.fail("backfill must not delete a folder")
    },
    messages: {
      query: async query => {
        onQuery(query);
        return pages[query.folderId]?.first ?? {id: null, messages: []};
      },
      continueList: async pageId => pages[pageId],
      abortList: async () => assert.fail("an exhausted backfill must not abort pagination"),
      listInlineTextParts: async () => assert.fail("backfill must not read message bodies"),
      getFull: async () => assert.fail("backfill must not read full messages"),
      move: async () => assert.fail("backfill must not move messages")
    },
    messengerUtilities: {
      parseMailboxString: async value => parseMailboxes(value)
    }
  };
}

function normalFolder(id, name) {
  return {id, accountId: "work", name, specialUse: []};
}

function addressBook(id, name, overrides = {}) {
  return {
    id,
    name,
    type: "addressBook",
    readOnly: false,
    remote: false,
    ...overrides
  };
}

function vCard(email) {
  return `BEGIN:VCARD\r\nVERSION:4.0\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
}

test("backfill exhausts all 4,000 header-only messages without a date or preview cap", async () => {
  const acmeFolder = normalFolder("acme-folder", "Acme");
  const headers = Array.from({length: 4000}, (_, index) => message(index + 1));
  const pages = {};
  for (let index = 0; index < 4; index += 1) {
    const nextId = index < 3 ? `page-${index + 2}` : null;
    const page = {id: nextId, messages: headers.slice(index * 1000, (index + 1) * 1000)};
    if (index === 0) pages[acmeFolder.id] = {first: page};
    else pages[`page-${index + 1}`] = page;
  }
  const queries = [];
  const progress = [];
  const api = scanApi({
    folders: {acme: acmeFolder},
    pages,
    onQuery: query => queries.push(query)
  });

  const result = await scanExistingCustomerContacts({
    account,
    config: config(),
    api,
    onProgress: update => progress.push(update)
  });

  assert.equal(result.status, "complete");
  assert.equal(result.messagesScanned, 4000);
  assert.equal(result.foldersScanned, 1);
  assert.equal(result.groups[0].messagesScanned, 4000);
  assert.deepEqual(result.groups[0].candidates, [
    {name: "Alice", email: "alice@acme.example"}
  ]);
  assert.deepEqual(queries, [{
    folderId: "acme-folder",
    includeSubFolders: true,
    messagesPerPage: 100,
    autoPaginationTimeout: 500
  }]);
  assert.equal("fromDate" in queries[0], false);
  assert.ok(progress.some(update =>
    update.stage === "messages" && update.messagesScanned === 4000
  ));
  assert.equal(progress.at(-1).stage, "complete");
});

test("backfill scans only applicable configured folder trees and filters exact header owners", async () => {
  const acmeFolder = normalFolder("acme-folder", "Acme");
  const unrelatedFolder = normalFolder("unrelated-folder", "Unrelated");
  const disabledFolder = normalFolder("disabled-folder", "Disabled");
  const otherAccountFolder = normalFolder("other-folder", "Other account");
  const queries = [];
  const api = scanApi({
    folders: {
      acme: acmeFolder,
      unrelated: unrelatedFolder,
      disabled: disabledFolder,
      other: otherAccountFolder
    },
    pages: {
      [acmeFolder.id]: {
        first: {
          id: null,
          messages: [message(1, {
            author: "Alice <alice@acme.example>",
            recipients: [
              "Own identity <me@acme.example>",
              "Exact shared provider <customer.contact@gmail.com>"
            ],
            ccList: [
              "Subdomain <person@mail.acme.example>",
              "Outside <outside@example.net>"
            ],
            bccList: ["Alias <alias@acme.example>"]
          })]
        }
      }
    },
    onQuery: query => queries.push(query)
  });
  const rules = [
    customer({addresses: ["customer.contact@gmail.com"]}),
    customer({id: "disabled", name: "Disabled", folderName: "Disabled", enabled: false}),
    customer({
      id: "other",
      name: "Other account",
      folderName: "Other account",
      accountIds: ["other"]
    })
  ];

  const result = await scanExistingCustomerContacts({
    account,
    config: config(rules),
    api
  });

  assert.deepEqual(queries.map(query => query.folderId), ["acme-folder"]);
  assert.equal(queries[0].includeSubFolders, true);
  assert.deepEqual(result.groups.map(group => group.customerId), ["acme"]);
  assert.deepEqual(result.groups[0].candidates, [
    {name: "Alice", email: "alice@acme.example"},
    {name: "Exact shared provider", email: "customer.contact@gmail.com"}
  ]);
});

test("a missing customer folder is reported and skipped without being created", async () => {
  let queries = 0;
  const progress = [];
  const api = scanApi({onQuery: () => { queries += 1; }});

  const result = await scanExistingCustomerContacts({
    account,
    config: config(),
    api,
    onProgress: update => progress.push(update)
  });

  assert.equal(result.status, "partial");
  assert.equal(result.messagesScanned, 0);
  assert.equal(result.foldersScanned, 0);
  assert.equal(queries, 0);
  assert.equal(result.skippedFolders.length, 1);
  assert.equal(result.skippedFolders[0].code, "missing-folder");
  assert.match(result.skippedFolders[0].message, /no folder was created/iu);
  assert.ok(progress.some(update => update.stage === "folder-skipped"));
});

test("an unapproved or missing customer root fails closed", async t => {
  await t.test("unapproved", async () => {
    let folderReads = 0;
    const api = scanApi();
    const original = api.folders.getSubFolders;
    api.folders.getSubFolders = async id => {
      folderReads += 1;
      return original(id);
    };
    await assert.rejects(
      scanExistingCustomerContacts({
        account,
        config: config([customer()], {customerRootReady: false}),
        api
      }),
      /not approved/iu
    );
    assert.equal(folderReads, 0);
  });

  await t.test("missing", async () => {
    const api = scanApi();
    api.folders.getSubFolders = async () => [];
    await assert.rejects(
      scanExistingCustomerContacts({account, config: config(), api}),
      /root folder is missing/iu
    );
  });
});

test("backfill rejects a customer root that changes during its read-only scan", async () => {
  const acmeFolder = normalFolder("acme-folder", "Acme");
  let rootReads = 0;
  const api = scanApi({
    folders: {acme: acmeFolder},
    pages: {
      [acmeFolder.id]: {first: {id: null, messages: [message(1)]}}
    }
  });
  api.folders.getSubFolders = async folderId => {
    if (folderId === account.rootFolder.id) {
      rootReads += 1;
      return [{
        id: rootReads <= 3 ? "customers" : "replacement-customers",
        accountId: "work",
        name: "Customers",
        specialUse: []
      }];
    }
    if (folderId === "customers" || folderId === "replacement-customers") {
      return [acmeFolder];
    }
    return [];
  };

  await assert.rejects(
    scanExistingCustomerContacts({account, config: config(), api}),
    /customer root changed/iu
  );
});

test("import inventories every address book once and deterministically owns cross-customer duplicates", async () => {
  const expectedName = managedContactBookName(account);
  const books = [
    addressBook("personal", "Personal Address Book"),
    addressBook("managed", expectedName)
  ];
  let bookLists = 0;
  const contactLists = [];
  const creates = [];
  const api = {
    addressBooks: {
      list: async () => {
        bookLists += 1;
        return books;
      },
      contacts: {
        list: async bookId => {
          contactLists.push(bookId);
          return bookId === "personal" ? [{vCard: vCard("existing@acme.example")}] : [];
        },
        create: async (bookId, card) => {
          creates.push({bookId, card});
          return `created-${creates.length}`;
        }
      }
    }
  };

  const result = await importExistingCustomerContacts({
    account,
    storedBook: {addressBookId: "managed", addressBookName: expectedName},
    groups: [
      {
        customerId: "acme",
        customerName: "Acme",
        candidates: [
          {name: "Shared first", email: "shared@example.com"},
          {name: "Existing", email: "EXISTING@ACME.EXAMPLE"}
        ]
      },
      {
        customerId: "beta",
        customerName: "Beta",
        candidates: [
          {name: "Shared second", email: "SHARED@example.com"},
          {name: "Beta", email: "beta@example.com"}
        ]
      }
    ],
    api
  });

  assert.equal(bookLists, 1);
  assert.deepEqual(contactLists, ["personal", "managed"]);
  assert.equal(result.attempted, 3);
  assert.equal(result.created, 2);
  assert.equal(result.existing, 1);
  assert.deepEqual(result.results.map(row => [row.email, row.customerId, row.status]), [
    ["shared@example.com", "acme", "created"],
    ["existing@acme.example", "acme", "existing"],
    ["beta@example.com", "beta", "created"]
  ]);
  assert.match(creates[0].card, /ORG:Acme\r\n/u);
  assert.doesNotMatch(creates[0].card, /ORG:Beta/u);
});

test("import creates sequentially, continues after a partial failure, and reports progress", async () => {
  const expectedName = managedContactBookName(account);
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const progress = [];
  const api = {
    addressBooks: {
      list: async () => [addressBook("managed", expectedName)],
      contacts: {
        list: async () => [],
        create: async () => {
          calls += 1;
          const current = calls;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise(resolve => setImmediate(resolve));
          active -= 1;
          if (current === 2) throw new Error("simulated contact write failure");
          return `created-${current}`;
        }
      }
    }
  };

  const result = await importExistingCustomerContacts({
    account,
    storedBook: {addressBookId: "managed", addressBookName: expectedName},
    groups: [{
      customerId: "acme",
      customerName: "Acme",
      candidates: [
        {email: "one@acme.example"},
        {email: "two@acme.example"},
        {email: "three@acme.example"}
      ]
    }],
    api,
    onProgress: update => progress.push(update)
  });

  assert.equal(maximumActive, 1);
  assert.equal(calls, 3);
  assert.equal(result.status, "partial");
  assert.equal(result.created, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results.map(row => row.status), ["created", "failed", "created"]);
  assert.match(result.errors[0], /simulated contact write failure/iu);
  assert.equal(progress[0].stage, "start");
  assert.deepEqual(progress.at(-1), {
    phase: "importing",
    stage: "complete",
    attempted: 3,
    processed: 3,
    created: 2,
    existing: 0,
    failed: 1,
    customerId: "acme",
    customerName: "Acme"
  });
});

test("import fails before contact creation when the managed book is renamed or read-only", async t => {
  const expectedName = managedContactBookName(account);
  for (const [label, book, expectedError] of [
    ["renamed", addressBook("managed", "Renamed book"), /was renamed/iu],
    ["read-only", addressBook("managed", expectedName, {readOnly: true}), /read-only/iu]
  ]) {
    await t.test(label, async () => {
      let creates = 0;
      const result = await importExistingCustomerContacts({
        account,
        storedBook: {addressBookId: "managed", addressBookName: expectedName},
        groups: [{
          customerId: "acme",
          customerName: "Acme",
          candidates: [{email: "alice@acme.example"}]
        }],
        api: {
          addressBooks: {
            list: async () => [book],
            contacts: {
              list: async () => assert.fail("invalid managed book must fail before dedupe"),
              create: async () => { creates += 1; }
            }
          }
        }
      });

      assert.equal(result.status, "unavailable");
      assert.equal(result.failed, 1);
      assert.match(result.errors[0], expectedError);
      assert.equal(creates, 0);
    });
  }
});

test("rerunning an existing-mail import is idempotent", async () => {
  const expectedName = managedContactBookName(account);
  const storedContacts = [];
  let creates = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("managed", expectedName)],
      contacts: {
        list: async () => storedContacts,
        create: async (_bookId, card) => {
          creates += 1;
          storedContacts.push({vCard: card});
          return `created-${creates}`;
        }
      }
    }
  };
  const request = {
    account,
    storedBook: {addressBookId: "managed", addressBookName: expectedName},
    groups: [{
      customerId: "acme",
      customerName: "Acme",
      candidates: [{name: "Alice", email: "alice@acme.example"}]
    }],
    api
  };

  const first = await importExistingCustomerContacts(request);
  const second = await importExistingCustomerContacts(request);

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.existing, 1);
  assert.equal(creates, 1);
});
