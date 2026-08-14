// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import {managedContactBookName} from "../extension/lib/contact-book.js";

function listenerSlot() {
  return {
    listener: null,
    addListener(listener) { this.listener = listener; }
  };
}

test("setup adopts existing folders and contact book, imports rules, and activates automation", async t => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const domains = {id: "domains", accountId: "work", name: "Domains", specialUse: []};
  const archive = {id: "archive", accountId: "work", name: "Archive", specialUse: []};
  const customerFolder = {
    id: "acme",
    accountId: "work",
    name: "acme.com",
    specialUse: []
  };
  const account = {
    id: "work",
    name: "Work",
    type: "imap",
    identities: [{id: "identity", email: "me@work.com", name: "Me"}],
    rootFolder: {
      id: "root",
      accountId: "work",
      name: "Work",
      isRoot: true,
      subFolders: [inbox, domains, archive]
    }
  };
  const storage = {
    config: {
      schemaVersion: 3,
      revision: 1,
      defaultDays: 7,
      maxMessagesPerRun: 1000,
      scanSubject: true,
      scanBody: false,
      preserveFlagged: true,
      accounts: {
        work: {
          initialized: true,
          enabled: true,
          rootFolderName: "Domains",
          customerRootReady: false,
          archiveFolderName: "Archive",
          archiveReady: false,
          autoFileRequested: true,
          autoFileIncoming: false,
          autoFileSince: null,
          internalContactDomains: ["work.com"]
        }
      },
      customers: []
    },
    automaticNewBaselines: {},
    automaticSuppressions: {},
    managedContactBooks: {}
  };
  const existingContactBook = {
    id: "existing-managed-work",
    name: managedContactBookName(account),
    type: "addressBook",
    remote: false,
    readOnly: false
  };
  const sentinelContact = {
    id: "sentinel-contact",
    type: "contact",
    vCard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Existing Person\r\nEMAIL:existing@example.com\r\nEND:VCARD\r\n"
  };
  const books = [existingContactBook];
  const contacts = [sentinelContact];
  const addressBookCreates = [];
  const contactCreates = [];
  const folderCreates = [];
  const messageListener = listenerSlot();
  const passiveListener = () => listenerSlot();

  globalThis.messenger = {
    accounts: {
      list: async () => [account],
      get: async id => id === account.id ? account : null
    },
    addressBooks: {
      list: async () => structuredClone(books),
      create: async properties => {
        addressBookCreates.push(structuredClone(properties));
        return "unexpected-new-book";
      },
      contacts: {
        list: async id => {
          assert.equal(id, existingContactBook.id);
          return structuredClone(contacts);
        },
        create: async (id, properties) => {
          contactCreates.push({id, properties: structuredClone(properties)});
          return "unexpected-new-contact";
        }
      }
    },
    storage: {
      local: {
        get: async keys => {
          const selected = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.hasOwn(storage, key)) selected[key] = structuredClone(storage[key]);
          }
          return selected;
        },
        set: async values => {
          for (const [key, value] of Object.entries(values)) {
            storage[key] = structuredClone(value);
          }
        }
      },
      session: {get: async () => ({}), set: async () => {}, remove: async () => {}}
    },
    folders: {
      getSubFolders: async id => {
        if (id === "root") return [inbox, domains, archive];
        if (id === "domains") return [customerFolder];
        return [];
      },
      getFolderCapabilities: async id => ({
        canAddSubfolders: id === "root" || id === "domains",
        canAddMessages: id === "archive" || id === "acme",
        canDeleteMessages: true
      }),
      create: async (...args) => {
        folderCreates.push(args);
        throw new Error("existing setup folders must be reused");
      },
      getParentFolders: async () => []
    },
    messages: {
      list: async id => {
        assert.equal(id, "inbox");
        return {id: null, messages: []};
      },
      abortList: async () => {},
      continueList: async () => assert.fail("single-page baseline must not continue"),
      onMoved: passiveListener(),
      onCopied: passiveListener(),
      onNewMailReceived: passiveListener()
    },
    runtime: {
      onMessage: messageListener,
      onInstalled: passiveListener(),
      onStartup: passiveListener(),
      sendMessage: async () => {},
      getURL: path => path,
      openOptionsPage: async () => {}
    },
    menus: {create: () => {}, onClicked: passiveListener()},
    tabs: {create: async () => {}},
    alarms: {get: async name => ({name}), create: () => {}, onAlarm: passiveListener()}
  };
  t.after(() => { delete globalThis.messenger; });

  await import(`../extension/background.js?setup=${Date.now()}`);
  const response = await messageListener.listener({dmo: true, command: "setupFolders"});

  assert.deepEqual(folderCreates, []);
  assert.deepEqual(addressBookCreates, []);
  assert.deepEqual(contactCreates, []);
  assert.deepEqual(contacts, [sentinelContact]);
  assert.equal(response.result.errors.length, 0);
  assert.equal(response.result.importedCustomers.length, 1);
  assert.equal(response.config.accounts.work.customerRootReady, true);
  assert.equal(response.config.accounts.work.archiveReady, true);
  assert.equal(response.config.accounts.work.autoFileRequested, true);
  assert.equal(response.config.accounts.work.autoFileIncoming, true);
  assert.equal(storage.config.accounts.work.autoFileIncoming, true);
  assert.equal(response.config.customers.length, 1);
  assert.equal(response.config.customers[0].folderName, "acme.com");
  assert.deepEqual(response.config.customers[0].domains, ["acme.com"]);
  assert.equal(response.config.customers[0].enabled, true);
  assert.deepEqual(response.managedContactBooks.work, {
    addressBookId: existingContactBook.id,
    addressBookName: existingContactBook.name
  });
  assert.deepEqual(storage.managedContactBooks.work, {
    addressBookId: existingContactBook.id,
    addressBookName: existingContactBook.name
  });
  assert.equal(storage.automaticNewBaselines.work.schemaVersion, 3);
});

test("setup fails closed when an adopted contact book changes before binding", async t => {
  const raceCases = [
    {
      name: "renamed",
      afterAdoption: book => [{...book, name: "Renamed during setup"}],
      expectedError: /was renamed/iu
    },
    {
      name: "deleted",
      afterAdoption: () => [],
      expectedError: /is missing/iu
    },
    {
      name: "duplicate",
      afterAdoption: book => [
        book,
        {...book, id: "concurrent-duplicate"}
      ],
      expectedError: /more than one address book/iu
    }
  ];

  for (const raceCase of raceCases) {
    await t.test(raceCase.name, async () => {
      const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
      const domains = {id: "domains", accountId: "work", name: "Domains", specialUse: []};
      const archive = {id: "archive", accountId: "work", name: "Archive", specialUse: []};
      const account = {
        id: "work",
        name: "Work",
        type: "imap",
        identities: [{id: "identity", email: "me@work.com", name: "Me"}],
        rootFolder: {
          id: "root",
          accountId: "work",
          name: "Work",
          isRoot: true,
          subFolders: [inbox, domains, archive]
        }
      };
      const existingContactBook = {
        id: "existing-managed-work",
        name: managedContactBookName(account),
        type: "addressBook",
        remote: false,
        readOnly: false
      };
      const storage = {
        config: {
          schemaVersion: 3,
          revision: 1,
          defaultDays: 7,
          maxMessagesPerRun: 1000,
          scanSubject: true,
          scanBody: false,
          preserveFlagged: true,
          accounts: {
            work: {
              initialized: true,
              enabled: true,
              rootFolderName: "Domains",
              customerRootReady: false,
              archiveFolderName: "Archive",
              archiveReady: false,
              autoFileRequested: true,
              autoFileIncoming: false,
              autoFileSince: null,
              internalContactDomains: ["work.com"]
            }
          },
          customers: []
        },
        automaticNewBaselines: {},
        automaticSuppressions: {},
        managedContactBooks: {}
      };
      const messageListener = listenerSlot();
      const passiveListener = () => listenerSlot();
      let addressBookListCalls = 0;
      let addressBookCreateCalls = 0;

      globalThis.messenger = {
        accounts: {
          list: async () => [account],
          get: async id => id === account.id ? account : null
        },
        addressBooks: {
          list: async () => {
            addressBookListCalls += 1;
            return structuredClone(
              addressBookListCalls === 1
                ? [existingContactBook]
                : raceCase.afterAdoption(existingContactBook)
            );
          },
          create: async () => {
            addressBookCreateCalls += 1;
            return "unexpected-new-book";
          },
          contacts: {
            list: async () => assert.fail("failed setup must not inventory contacts"),
            create: async () => assert.fail("failed setup must not create contacts")
          }
        },
        storage: {
          local: {
            get: async keys => {
              const selected = {};
              for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(storage, key)) selected[key] = structuredClone(storage[key]);
              }
              return selected;
            },
            set: async values => {
              for (const [key, value] of Object.entries(values)) {
                storage[key] = structuredClone(value);
              }
            }
          },
          session: {get: async () => ({}), set: async () => {}, remove: async () => {}}
        },
        folders: {
          getSubFolders: async id => {
            if (id === "root") return [inbox, domains, archive];
            return [];
          },
          getFolderCapabilities: async id => ({
            canAddSubfolders: id === "root" || id === "domains",
            canAddMessages: id === "archive",
            canDeleteMessages: true
          }),
          create: async () => assert.fail("existing setup folders must be reused"),
          getParentFolders: async () => []
        },
        messages: {
          list: async () => ({id: null, messages: []}),
          abortList: async () => {},
          continueList: async () => assert.fail("single-page baseline must not continue"),
          onMoved: passiveListener(),
          onCopied: passiveListener(),
          onNewMailReceived: passiveListener()
        },
        runtime: {
          onMessage: messageListener,
          onInstalled: passiveListener(),
          onStartup: passiveListener(),
          sendMessage: async () => {},
          getURL: path => path,
          openOptionsPage: async () => {}
        },
        menus: {create: () => {}, onClicked: passiveListener()},
        tabs: {create: async () => {}},
        alarms: {get: async name => ({name}), create: () => {}, onAlarm: passiveListener()}
      };

      try {
        await import(`../extension/background.js?setup-race=${Date.now()}-${raceCase.name}`);
        const response = await messageListener.listener({dmo: true, command: "setupFolders"});

        assert.equal(addressBookListCalls, 2);
        assert.equal(addressBookCreateCalls, 0);
        assert.equal(response.result.errors.length, 1);
        assert.match(response.result.errors[0], raceCase.expectedError);
        assert.deepEqual(response.managedContactBooks, {});
        assert.deepEqual(storage.managedContactBooks, {});
        assert.equal(response.config.accounts.work.autoFileRequested, true);
        assert.equal(response.config.accounts.work.autoFileIncoming, false);
        assert.equal(storage.config.accounts.work.autoFileIncoming, false);
      } finally {
        delete globalThis.messenger;
      }
    });
  }
});
