import test from "node:test";
import assert from "node:assert/strict";

import {
  captureMovedMessageContacts,
  importManagedContactGroups,
  importManagedContacts,
  managedContactBookName,
  setupManagedContactBook,
  validateManagedContactBook
} from "../extension/lib/contact-book.js";

const account = {id: "work", name: "Work"};
const expectedName = "Customer Contacts — Work (work)";

function addressBook(id, name = expectedName, overrides = {}) {
  return {
    id,
    name,
    type: "addressBook",
    readOnly: false,
    remote: false,
    ...overrides
  };
}

function contact(email) {
  return {
    id: `contact-${email}`,
    type: "contact",
    vCard: [
      "BEGIN:VCARD",
      "VERSION:4.0",
      `EMAIL;TYPE=work:mailto:${email}`,
      "END:VCARD",
      ""
    ].join("\r\n")
  };
}

test("managed address book names are deterministic per mail account", () => {
  assert.equal(managedContactBookName({id: "work", name: " Work "}), expectedName);
  assert.equal(
    managedContactBookName({
      id: "first",
      name: "Gmail",
      identities: [{email: "first@example.com"}]
    }),
    "Customer Contacts — first@example.com (first)"
  );
  assert.notEqual(
    managedContactBookName({
      id: "first",
      name: "Gmail",
      identities: [{email: "first@example.com"}]
    }),
    managedContactBookName({
      id: "second",
      name: "Gmail",
      identities: [{email: "second@example.com"}]
    })
  );
  assert.throws(() => managedContactBookName({id: "work", name: ""}), /name is required/u);
  assert.throws(() => managedContactBookName({name: "Work"}), /ID is required/u);
});

test("explicit setup creates a missing managed address book", async () => {
  const createCalls = [];
  const api = {
    addressBooks: {
      list: async () => [addressBook("personal", "Personal Address Book")],
      create: async properties => {
        createCalls.push(properties);
        return "managed-work";
      }
    }
  };

  const result = await setupManagedContactBook(account, null, api);

  assert.deepEqual(createCalls, [{name: expectedName}]);
  assert.deepEqual(result, {
    accountId: "work",
    addressBookId: "managed-work",
    addressBookName: expectedName,
    created: true
  });
});

test("explicit setup reuses only the valid book identified by stored state", async () => {
  let createCalls = 0;
  const api = {
    addressBooks: {
      list: async () => [
        addressBook("personal", "Personal Address Book"),
        addressBook("managed-work")
      ],
      create: async () => {
        createCalls += 1;
      }
    }
  };

  const result = await setupManagedContactBook(account, "managed-work", api);

  assert.equal(result.addressBookId, "managed-work");
  assert.equal(result.created, false);
  assert.equal(createCalls, 0);
});

test("read-only readiness validation never creates or adopts a managed book", async () => {
  let creates = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("managed-work")],
      create: async () => {
        creates += 1;
      }
    }
  };

  assert.deepEqual(
    await validateManagedContactBook(account, "managed-work", api),
    {
      accountId: "work",
      addressBookId: "managed-work",
      addressBookName: expectedName
    }
  );
  await assert.rejects(
    validateManagedContactBook(account, "missing", api),
    /is missing/u
  );
  assert.equal(creates, 0);
});

test("stored managed-book names survive mail-account display-name changes", async () => {
  const api = {
    addressBooks: {
      list: async () => [addressBook("managed-work")]
    }
  };
  const renamedAccount = {id: "work", name: "Renamed Work Account"};

  assert.deepEqual(
    await validateManagedContactBook(renamedAccount, {
      addressBookId: "managed-work",
      addressBookName: expectedName
    }, api),
    {
      accountId: "work",
      addressBookId: "managed-work",
      addressBookName: expectedName
    }
  );
});

test("setup refuses a same-name unowned address book instead of adopting it", async () => {
  let createCalls = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("unowned", "customer contacts — work (work)")],
      create: async () => {
        createCalls += 1;
      }
    }
  };

  await assert.rejects(
    setupManagedContactBook(account, null, api),
    /already exists and is not managed/u
  );
  assert.equal(createCalls, 0);
});

test("setup does not claim an unowned collision when its stored ID went stale", async () => {
  let createCalls = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("unowned")],
      create: async () => {
        createCalls += 1;
      }
    }
  };

  await assert.rejects(
    setupManagedContactBook(account, "deleted-managed-book", api),
    /not managed/u
  );
  assert.equal(createCalls, 0);
});

test("explicit setup can replace a stale ID only when its name is unused", async () => {
  const createCalls = [];
  const api = {
    addressBooks: {
      list: async () => [addressBook("personal", "Personal Address Book")],
      create: async properties => {
        createCalls.push(properties);
        return "replacement";
      }
    }
  };

  const result = await setupManagedContactBook(account, "deleted-managed-book", api);

  assert.equal(result.addressBookId, "replacement");
  assert.equal(result.created, true);
  assert.deepEqual(createCalls, [{name: expectedName}]);
});

test("setup rejects a renamed, remote, or read-only stored book", async t => {
  const cases = [
    [addressBook("managed", "Renamed"), /was renamed/u],
    [addressBook("managed", expectedName, {remote: true}), /must be local/u],
    [addressBook("managed", expectedName, {readOnly: true}), /read-only/u]
  ];
  for (const [storedBook, expectedError] of cases) {
    await t.test(expectedError.source, async () => {
      let createCalls = 0;
      const api = {
        addressBooks: {
          list: async () => [storedBook],
          create: async () => {
            createCalls += 1;
          }
        }
      };
      await assert.rejects(
        setupManagedContactBook(account, "managed", api),
        expectedError
      );
      assert.equal(createCalls, 0);
    });
  }
});

test("automatic import never creates or rebinds a missing address book", async () => {
  let bookCreateCalls = 0;
  let contactListCalls = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("lookalike")],
      create: async () => {
        bookCreateCalls += 1;
      },
      contacts: {
        list: async () => {
          contactListCalls += 1;
          return [];
        },
        create: async () => assert.fail("a contact must not be created")
      }
    }
  };

  const result = await importManagedContacts(
    account,
    "deleted-managed-book",
    [{name: "Alice", email: "alice@acme.example"}],
    "Acme",
    api
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.failed, 1);
  assert.equal(bookCreateCalls, 0);
  assert.equal(contactListCalls, 0);
});

test("import deduplicates exact normalized emails across every address book", async () => {
  const listed = [];
  const created = [];
  const books = [
    addressBook("personal", "Personal Address Book"),
    addressBook("managed")
  ];
  const api = {
    addressBooks: {
      list: async () => books,
      contacts: {
        list: async bookId => {
          listed.push(bookId);
          return bookId === "personal" ? [contact("Alice@Acme.Example")] : [];
        },
        create: async (bookId, vCard) => {
          created.push({bookId, vCard});
          return "new-bob";
        }
      }
    }
  };

  const result = await importManagedContacts(
    account,
    "managed",
    [
      {name: "Alice", email: "alice@acme.example"},
      {name: "Bob", email: "BOB@acme.example"},
      {name: "Duplicate Bob", email: "bob@ACME.EXAMPLE"}
    ],
    "Acme, Inc.",
    api
  );

  assert.deepEqual(listed, ["personal", "managed"]);
  assert.equal(result.status, "complete");
  assert.equal(result.attempted, 2);
  assert.equal(result.existing, 1);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].bookId, "managed");
  assert.match(created[0].vCard, /FN:bob@acme\.example\r\n/u);
  assert.match(created[0].vCard, /EMAIL:bob@acme\.example\r\n/u);
  assert.match(created[0].vCard, /ORG:Acme\\, Inc\.\r\n/u);
});

test("group import inventories address books once and assigns duplicate emails to the first group", async () => {
  let bookListCalls = 0;
  const contactListCalls = [];
  const created = [];
  const api = {
    addressBooks: {
      list: async () => {
        bookListCalls += 1;
        return [
          addressBook("personal", "Personal Address Book"),
          addressBook("managed")
        ];
      },
      contacts: {
        list: async bookId => {
          contactListCalls.push(bookId);
          return [];
        },
        create: async (bookId, vCard) => {
          created.push({bookId, vCard});
          return `created-${created.length}`;
        }
      }
    }
  };

  const result = await importManagedContactGroups(
    account,
    "managed",
    [
      {
        organization: "google.com",
        candidates: [
          {name: "Employee", email: "employee@google.com"}
        ]
      },
      {
        organization: "Customer Google",
        candidates: [
          {name: "Duplicate", email: "EMPLOYEE@google.com"},
          {name: "Customer", email: "customer@example.com"}
        ]
      }
    ],
    api
  );

  assert.equal(bookListCalls, 1);
  assert.deepEqual(contactListCalls, ["personal", "managed"]);
  assert.equal(result.attempted, 2);
  assert.equal(result.created, 2);
  assert.equal(created.length, 2);
  assert.match(created[0].vCard, /EMAIL:employee@google\.com\r\nORG:google\.com\r\n/u);
  assert.doesNotMatch(created[0].vCard, /Customer Google/u);
  assert.match(created[1].vCard, /EMAIL:customer@example\.com\r\nORG:Customer Google\r\n/u);
});

test("a global contact scan failure fails closed before creating anything", async () => {
  let contactCreateCalls = 0;
  const api = {
    addressBooks: {
      list: async () => [
        addressBook("managed"),
        addressBook("remote", "Company directory", {remote: true, readOnly: true})
      ],
      contacts: {
        list: async bookId => {
          if (bookId === "remote") throw new Error("directory offline");
          return [];
        },
        create: async () => {
          contactCreateCalls += 1;
        }
      }
    }
  };

  const result = await importManagedContacts(
    account,
    "managed",
    [{email: "alice@acme.example"}],
    "Acme",
    api
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /directory offline/u);
  assert.equal(contactCreateCalls, 0);
});

test("contact creation is sequential and continues after individual failures", async () => {
  let activeCreates = 0;
  let maximumActiveCreates = 0;
  let createNumber = 0;
  const api = {
    addressBooks: {
      list: async () => [addressBook("managed")],
      contacts: {
        list: async () => [],
        create: async () => {
          createNumber += 1;
          const current = createNumber;
          activeCreates += 1;
          maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
          await new Promise(resolve => setImmediate(resolve));
          activeCreates -= 1;
          if (current === 2) throw new Error("simulated write failure");
          return `created-${current}`;
        }
      }
    }
  };

  const result = await importManagedContacts(
    account,
    "managed",
    [
      {email: "one@acme.example"},
      {email: "two@acme.example"},
      {email: "three@acme.example"}
    ],
    "Acme",
    api
  );

  assert.equal(maximumActiveCreates, 1);
  assert.equal(createNumber, 3);
  assert.equal(result.status, "partial");
  assert.equal(result.created, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results.map(item => item.status), [
    "created",
    "failed",
    "created"
  ]);
  assert.match(result.results[1].error, /simulated write failure/u);
});

test("completed automatic moves capture only customer-owned non-identity contacts", async () => {
  const created = [];
  const identityBookName = "Customer Contacts — me@acme.example (work)";
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => {
        const email = String(value).match(/[\w.+-]+@[\w.-]+/u)?.[0] ?? "";
        return email ? [{name: String(value).split("<", 1)[0].trim(), email}] : [];
      }
    },
    addressBooks: {
      list: async () => [addressBook("managed", identityBookName)],
      contacts: {
        list: async () => [],
        create: async (bookId, vCard) => {
          created.push({bookId, vCard});
          return `contact-${created.length}`;
        }
      }
    }
  };
  const config = {
    customers: [{
      id: "acme",
      name: "Acme",
      domains: ["acme.example"],
      addresses: []
    }]
  };

  const result = await captureMovedMessageContacts({
    account: {...account, identities: [{email: "me@acme.example"}]},
    storedBook: {
      addressBookId: "managed",
      addressBookName: identityBookName
    },
    config,
    completed: [{
      item: {customerId: "acme"},
      message: {
        author: "Alice <alice@acme.example>",
        recipients: ["Me <me@acme.example>"],
        ccList: ["Subdomain <person@mail.acme.example>"],
        bccList: ["Outside <outside@example.net>"]
      },
      result: {status: "completed"}
    }],
    api
  });

  assert.deepEqual(result, {
    attempted: 1,
    created: 1,
    existing: 0,
    failed: 0
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].bookId, "managed");
  assert.match(created[0].vCard, /EMAIL:alice@acme\.example\r\n/u);
  assert.doesNotMatch(created[0].vCard, /me@|mail\.acme|outside@/u);
});

test("automatic capture imports exact internal and customer groups with one global inventory", async () => {
  let bookListCalls = 0;
  const contactListCalls = [];
  const created = [];
  const identityBookName = "Customer Contacts â€” ubhi@google.com (work)";
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => {
        const email = String(value).match(/[\w.+-]+@[\w.-]+/u)?.[0] ?? "";
        return email ? [{name: String(value).split("<", 1)[0].trim(), email}] : [];
      }
    },
    addressBooks: {
      list: async () => {
        bookListCalls += 1;
        return [
          addressBook("personal", "Personal Address Book"),
          addressBook("managed", identityBookName)
        ];
      },
      contacts: {
        list: async bookId => {
          contactListCalls.push(bookId);
          return [];
        },
        create: async (bookId, vCard) => {
          created.push({bookId, vCard});
          return `contact-${created.length}`;
        }
      }
    }
  };
  const config = {
    accounts: {
      work: {internalContactDomains: ["google.com", "unapproved.example"]}
    },
    customers: [
      {
        id: "acme",
        name: "Acme",
        domains: ["acme.example", "google.com"],
        addresses: []
      },
      {
        id: "beta",
        name: "Beta",
        domains: ["beta.example"],
        addresses: []
      }
    ]
  };

  const result = await captureMovedMessageContacts({
    account: {...account, identities: [{email: "ubhi@google.com"}]},
    storedBook: {
      addressBookId: "managed",
      addressBookName: identityBookName
    },
    config,
    completed: [
      {
        item: {customerId: "acme"},
        message: {
          author: "Alice <alice@acme.example>",
          recipients: [
            "Employee <employee@google.com>",
            "Me <ubhi@google.com>",
            "Unapproved <person@unapproved.example>"
          ],
          ccList: ["Subdomain <mailer@em.google.com>"],
          bccList: []
        }
      },
      {
        item: {customerId: "beta"},
        message: {
          author: "Bob <bob@beta.example>",
          recipients: [
            "Employee <employee@google.com>",
            "Colleague <colleague@google.com>"
          ],
          ccList: [],
          bccList: ["Outside <outside@example.net>"]
        }
      }
    ],
    api
  });

  assert.deepEqual(result, {
    attempted: 4,
    created: 4,
    existing: 0,
    failed: 0
  });
  assert.equal(bookListCalls, 1);
  assert.deepEqual(contactListCalls, ["personal", "managed"]);
  assert.deepEqual(
    created.map(item => item.vCard.match(/EMAIL:([^\r]+)/u)?.[1]),
    [
      "employee@google.com",
      "colleague@google.com",
      "alice@acme.example",
      "bob@beta.example"
    ]
  );
  assert.match(created[0].vCard, /ORG:google\.com\r\n/u);
  assert.equal(created.some(entry => entry.vCard.includes("person@unapproved.example")), false);
  assert.match(created[1].vCard, /ORG:google\.com\r\n/u);
  assert.match(created[2].vCard, /ORG:Acme\r\n/u);
  assert.match(created[3].vCard, /ORG:Beta\r\n/u);
  assert.equal(created.some(item => /ubhi@|em\.google|outside@/u.test(item.vCard)), false);
});
