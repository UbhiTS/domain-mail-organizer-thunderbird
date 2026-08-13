import test from "node:test";
import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise(promiseResolve => {
    resolve = promiseResolve;
  });
  return {promise, resolve};
}

function listenerSlot() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    }
  };
}

test("a concurrent settings save wins over an older loadState migration snapshot", async t => {
  const inbox = {
    id: "work-inbox",
    accountId: "work",
    name: "Inbox",
    specialUse: ["inbox"],
    subFolders: []
  };
  const account = {
    id: "work",
    name: "Work",
    type: "imap",
    identities: [{id: "identity", email: "me@work.example", name: "Me"}],
    rootFolder: {
      id: "work-root",
      accountId: "work",
      name: "Work",
      isRoot: true,
      subFolders: [inbox]
    }
  };
  const initialConfig = {
    schemaVersion: 2,
    revision: 1,
    defaultDays: 7,
    maxMessagesPerRun: 1000,
    scanSubject: true,
    scanBody: false,
    preserveFlagged: true,
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: true,
        archiveFolderName: "Organizer Archive",
        archiveReady: false,
        autoFileIncoming: true,
        autoFileSince: null,
        internalContactDomains: []
      }
    },
    // Legacy stored rules may not have IDs yet. The state CAS must compare the
    // raw storage snapshot, not normalize twice and generate two random IDs.
    customers: [{
      name: "Customer",
      folderName: "Customer",
      enabled: true,
      accountIds: ["work"],
      domains: ["customer.com"],
      addresses: [],
      keywords: []
    }]
  };
  const storage = {
    config: structuredClone(initialConfig),
    automaticNewBaselines: {},
    automaticSuppressions: {},
    managedContactBooks: {
      work: {
        addressBookId: "managed-work",
        addressBookName: "Managed Work"
      }
    }
  };
  const messageListener = listenerSlot();
  const passiveListener = () => listenerSlot();
  const listStarted = deferred();
  const releaseList = deferred();

  globalThis.messenger = {
    accounts: {
      list: async () => [account],
      get: async accountId => accountId === account.id ? account : null
    },
    addressBooks: {
      list: async () => [{
        id: "managed-work",
        name: "Managed Work",
        type: "addressBook",
        remote: false,
        readOnly: false
      }],
      contacts: {
        list: async () => [],
        create: async () => "contact"
      }
    },
    storage: {
      local: {
        get: async keys => {
          const selected = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.hasOwn(storage, key)) {
              selected[key] = structuredClone(storage[key]);
            }
          }
          return selected;
        },
        set: async values => {
          for (const [key, value] of Object.entries(values)) {
            storage[key] = structuredClone(value);
          }
        }
      },
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {}
      }
    },
    folders: {
      getSubFolders: async () => [],
      getFolderCapabilities: async () => ({
        canAddMessages: true,
        canAddSubfolders: true,
        canDeleteMessages: true
      }),
      getParentFolders: async () => []
    },
    messages: {
      list: async folderId => {
        assert.equal(folderId, inbox.id);
        listStarted.resolve();
        return releaseList.promise;
      },
      continueList: async () => assert.fail("the test Inbox has one page"),
      abortList: async () => {},
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
  t.after(() => {
    delete globalThis.messenger;
  });

  await import(`../extension/background.js?state-race=${Date.now()}`);
  const bootstrap = messageListener.listener({dmo: true, command: "getBootstrap"});
  await listStarted.promise;

  const savedConfig = structuredClone(initialConfig);
  savedConfig.defaultDays = 30;
  savedConfig.accounts.work.autoFileIncoming = false;
  const saved = await messageListener.listener({
    dmo: true,
    command: "saveConfig",
    config: savedConfig
  });
  assert.equal(saved.config.revision, 2);
  assert.equal(saved.config.defaultDays, 30);
  assert.equal(saved.config.accounts.work.autoFileIncoming, false);

  // Let the older Inbox census finish only after the newer settings commit.
  releaseList.resolve({id: null, messages: []});
  const bootstrapped = await bootstrap;

  assert.equal(storage.config.revision, 2);
  assert.equal(storage.config.defaultDays, 30);
  assert.equal(storage.config.accounts.work.autoFileIncoming, false);
  assert.equal(storage.config.accounts.work.autoFileSince, null);
  assert.equal(storage.automaticNewBaselines.work, undefined);
  assert.equal(bootstrapped.config.defaultDays, 30);
  assert.equal(bootstrapped.config.accounts.work.autoFileIncoming, false);
});
