import test from "node:test";
import assert from "node:assert/strict";

function listenerSlot() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    }
  };
}

function account(id, name, identity) {
  return {
    id,
    name,
    type: "imap",
    identities: [{id: `${id}-identity`, email: identity, name}],
    rootFolder: {
      id: `${id}-root`,
      accountId: id,
      name,
      isRoot: true,
      subFolders: []
    }
  };
}

function customer(id, accountId, domain) {
  return {
    id,
    name: `${id} customer`,
    folderName: `${id} customer`,
    enabled: true,
    accountIds: [accountId],
    domains: [domain],
    addresses: [],
    keywords: []
  };
}

function accountConfig(overrides = {}) {
  return {
    enabled: true,
    rootFolderName: "Customers",
    customerRootReady: true,
    archiveFolderName: "Organizer Archive",
    archiveReady: false,
    autoFileIncoming: false,
    autoFileSince: null,
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

function vCard(email) {
  return `BEGIN:VCARD\r\nVERSION:4.0\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
}

test("background backfill command aggregates results, reports progress, and isolates unready accounts", async t => {
  const accounts = [
    account("ready", "Ready", "me@ready.example"),
    account("root-unready", "Root unready", "me@root-unready.example"),
    account("book-unready", "Book unready", "me@book-unready.example"),
    account("scan-failure", "Scan failure", "me@scan-failure.example")
  ];
  const customers = [
    customer("Ready", "ready", "ready.example"),
    customer("Root unready", "root-unready", "root-unready.example"),
    customer("Book unready", "book-unready", "book-unready.example"),
    customer("Scan failure", "scan-failure", "scan-failure.example")
  ];
  const bookReferences = {
    ready: {addressBookId: "book-ready", addressBookName: "Ready contacts"},
    "root-unready": {
      addressBookId: "book-root-unready",
      addressBookName: "Root unready contacts"
    },
    "scan-failure": {
      addressBookId: "book-scan-failure",
      addressBookName: "Scan failure contacts"
    }
  };
  const books = [
    {id: "personal", name: "Personal Address Book", type: "addressBook", remote: false, readOnly: false},
    {id: "book-ready", name: "Ready contacts", type: "addressBook", remote: false, readOnly: false},
    {id: "book-root-unready", name: "Root unready contacts", type: "addressBook", remote: false, readOnly: false},
    {id: "book-scan-failure", name: "Scan failure contacts", type: "addressBook", remote: false, readOnly: false}
  ];
  const storage = {
    config: {
      schemaVersion: 2,
      revision: 1,
      defaultDays: 7,
      maxMessagesPerRun: 1000,
      scanSubject: true,
      scanBody: false,
      preserveFlagged: true,
      accounts: {
        ready: accountConfig(),
        "root-unready": accountConfig({customerRootReady: false}),
        "book-unready": accountConfig(),
        "scan-failure": accountConfig()
      },
      customers
    },
    managedContactBooks: bookReferences
  };
  const messageListener = listenerSlot();
  const progress = [];
  const createdCards = [];
  const queriedFolders = [];
  const subfolders = new Map();
  for (const current of accounts) {
    const root = {
      id: `${current.id}-customers`,
      accountId: current.id,
      name: "Customers",
      specialUse: []
    };
    const folder = {
      id: `${current.id}-customer-folder`,
      accountId: current.id,
      name: customers.find(item => item.accountIds[0] === current.id).folderName,
      specialUse: []
    };
    subfolders.set(current.rootFolder.id, [root]);
    subfolders.set(root.id, [folder]);
  }

  const passiveListener = () => listenerSlot();
  globalThis.messenger = {
    accounts: {
      list: async () => accounts,
      get: async id => accounts.find(current => current.id === id)
    },
    addressBooks: {
      list: async () => books,
      contacts: {
        list: async bookId => bookId === "personal"
          ? [{id: "existing", vCard: vCard("existing@ready.example")}]
          : [],
        create: async (bookId, card) => {
          createdCards.push({bookId, card});
          return `created-${createdCards.length}`;
        }
      }
    },
    storage: {
      local: {
        get: async keys => {
          const selected = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.hasOwn(storage, key)) selected[key] = storage[key];
          }
          return selected;
        },
        set: async values => Object.assign(storage, values)
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      }
    },
    folders: {
      getSubFolders: async folderId => subfolders.get(folderId) ?? [],
      getFolderCapabilities: async () => ({canAddMessages: true, canAddSubfolders: true})
    },
    messages: {
      query: async query => {
        queriedFolders.push(query.folderId);
        if (query.folderId === "scan-failure-customer-folder") {
          throw new Error("simulated folder read failure");
        }
        if (query.folderId !== "ready-customer-folder") {
          assert.fail(`unready account folder must not be queried: ${query.folderId}`);
        }
        return {
          id: null,
          messages: [{
            id: 1,
            author: "Alice <alice@ready.example>",
            recipients: [
              "Existing <existing@ready.example>",
              "Own identity <me@ready.example>"
            ],
            ccList: [],
            bccList: [],
            subject: "Headers only"
          }]
        };
      },
      continueList: async () => assert.fail("single-page test must not continue pagination"),
      abortList: async () => {},
      onMoved: passiveListener(),
      onCopied: passiveListener(),
      onNewMailReceived: passiveListener()
    },
    messengerUtilities: {
      parseMailboxString: async value => parseMailboxes(value)
    },
    runtime: {
      onMessage: messageListener,
      onInstalled: passiveListener(),
      onStartup: passiveListener(),
      sendMessage: async event => { progress.push(event); },
      getURL: path => path,
      openOptionsPage: async () => {}
    },
    menus: {
      create: () => {},
      onClicked: passiveListener()
    },
    tabs: {create: async () => {}},
    alarms: {
      get: async name => ({name}),
      create: () => {},
      onAlarm: passiveListener()
    }
  };
  t.after(() => { delete globalThis.messenger; });

  await import(`../extension/background.js?contact-backfill=${Date.now()}`);
  assert.equal(typeof messageListener.listener, "function");
  assert.equal(
    messageListener.listener({dmo: true, event: "contactBackfillProgress"}),
    undefined,
    "background events must not be redispatched as commands"
  );

  const result = await messageListener.listener({dmo: true, command: "backfillContacts"});

  assert.deepEqual(queriedFolders, [
    "ready-customer-folder",
    "scan-failure-customer-folder"
  ]);
  assert.equal(createdCards.length, 1);
  assert.equal(createdCards[0].bookId, "book-ready");
  assert.match(createdCards[0].card, /EMAIL:alice@ready\.example\r\n/u);
  assert.deepEqual(result.totals, {
    accountsProcessed: 4,
    foldersScanned: 1,
    messagesScanned: 1,
    attempted: 2,
    created: 1,
    existing: 1,
    failed: 0,
    skippedFolders: 1
  });

  const byId = Object.fromEntries(result.accounts.map(item => [item.accountId, item]));
  assert.deepEqual(
    [byId.ready.attempted, byId.ready.created, byId.ready.existing, byId.ready.failed],
    [2, 1, 1, 0]
  );
  assert.match(byId["root-unready"].errors[0], /domain root has not been set up/iu);
  assert.match(byId["book-unready"].errors[0], /address book has not been set up/iu);
  assert.equal(byId["scan-failure"].skippedFolders.length, 1);
  assert.match(
    byId["scan-failure"].skippedFolders[0].message,
    /simulated folder read failure/iu
  );

  assert.ok(progress.some(event =>
    event.dmo === true &&
    event.event === "contactBackfillProgress" &&
    event.phase === "scan" &&
    event.accountId === "ready" &&
    event.stage === "complete"
  ));
  assert.ok(progress.some(event =>
    event.dmo === true &&
    event.event === "contactBackfillProgress" &&
    event.phase === "import" &&
    event.accountId === "ready" &&
    event.stage === "complete"
  ));
  assert.deepEqual(progress.at(-1), {
    dmo: true,
    event: "contactBackfillProgress",
    phase: "complete",
    result,
    ...result.totals
  });
});
