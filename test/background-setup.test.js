// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

function listenerSlot() {
  return {
    listener: null,
    addListener(listener) { this.listener = listener; }
  };
}

test("setup adopts Domains and Archive, imports direct domain folders, and activates the saved automatic preference", async t => {
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
  const books = [];
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
      create: async ({name}) => {
        books.push({
          id: "managed-work",
          name,
          type: "addressBook",
          remote: false,
          readOnly: false
        });
        return "managed-work";
      },
      contacts: {list: async () => [], create: async () => "contact"}
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
  assert.equal(response.result.errors.length, 0);
  assert.equal(response.result.importedCustomers.length, 1);
  assert.equal(response.config.accounts.work.customerRootReady, true);
  assert.equal(response.config.accounts.work.archiveReady, true);
  assert.equal(response.config.accounts.work.autoFileRequested, true);
  assert.equal(response.config.accounts.work.autoFileIncoming, true);
  assert.equal(response.config.customers.length, 1);
  assert.equal(response.config.customers[0].folderName, "acme.com");
  assert.deepEqual(response.config.customers[0].domains, ["acme.com"]);
  assert.equal(response.config.customers[0].enabled, true);
  assert.equal(response.managedContactBooks.work.addressBookId, "managed-work");
  assert.equal(storage.automaticNewBaselines.work.schemaVersion, 3);
});
