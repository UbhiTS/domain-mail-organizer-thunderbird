import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_BASELINES_KEY,
  CONFIG_KEY
} from "../extension/lib/constants.js";
import {messageFingerprint} from "../extension/lib/fingerprint.js";

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

test("queued arrival hints respect a later disable but preserve activation hints", async t => {
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
  const storage = {
    [CONFIG_KEY]: {
      schemaVersion: 2,
      revision: 1,
      accounts: {
        work: {
          enabled: true,
          rootFolderName: "Customers",
          customerRootReady: true,
          archiveFolderName: "Archive",
          archiveReady: true,
          autoFileIncoming: true,
          autoFileSince: "2026-08-13T00:00:00.000Z",
          internalContactDomains: []
        }
      },
      customers: []
    },
    [AUTO_BASELINES_KEY]: {}
  };
  const baselineReadStarted = deferred();
  const releaseBaselineRead = deferred();
  let pauseNextQueuedBaselineRead = true;
  let localWrites = 0;
  const newMailListener = listenerSlot();
  const passiveListener = () => listenerSlot();

  async function getLocal(keys) {
    const requested = Array.isArray(keys) ? keys : [keys];
    // The serialized baseline owner requests this key first. Before the fix,
    // recordAutomaticArrivalHints performed a separate config-first read and
    // then ignored the fresher config returned by this queued read.
    if (pauseNextQueuedBaselineRead && requested[0] === AUTO_BASELINES_KEY) {
      pauseNextQueuedBaselineRead = false;
      baselineReadStarted.resolve();
      await releaseBaselineRead.promise;
    }
    return Object.fromEntries(requested.flatMap(key =>
      Object.hasOwn(storage, key) ? [[key, structuredClone(storage[key])]] : []
    ));
  }

  globalThis.messenger = {
    accounts: {
      list: async () => [account],
      get: async accountId => accountId === account.id ? account : null
    },
    addressBooks: {
      list: async () => [],
      contacts: {list: async () => [], create: async () => "contact"}
    },
    storage: {
      local: {
        get: getLocal,
        set: async update => {
          localWrites += 1;
          for (const [key, value] of Object.entries(update)) {
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
      list: async () => ({id: null, messages: []}),
      continueList: async () => assert.fail("the event has one page"),
      abortList: async () => {},
      onMoved: passiveListener(),
      onCopied: passiveListener(),
      onNewMailReceived: newMailListener
    },
    runtime: {
      onMessage: passiveListener(),
      onInstalled: passiveListener(),
      onStartup: passiveListener(),
      sendMessage: async () => {},
      getURL: path => path,
      openOptionsPage: async () => {}
    },
    menus: {create: () => {}, onClicked: passiveListener()},
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

  await import(`../extension/background.js?arrival-hints=${Date.now()}`);
  const firstMessage = {
    id: 101,
    folder: inbox,
    headerMessageId: "first@example.test",
    date: new Date("2026-08-13T01:00:00.000Z"),
    author: "Sender <sender@example.test>",
    recipients: ["me@work.example"],
    subject: "First",
    size: 100
  };
  const delayedEvent = newMailListener.listener(inbox, {
    id: null,
    messages: [firstMessage]
  });
  await baselineReadStarted.promise;
  storage[CONFIG_KEY].accounts.work.autoFileIncoming = false;
  storage[CONFIG_KEY].accounts.work.autoFileSince = null;
  releaseBaselineRead.resolve();
  assert.equal((await delayedEvent).status, "disabled");
  assert.equal(storage[AUTO_BASELINES_KEY].work, undefined);
  assert.equal(localWrites, 0, "disabled arrivals must not rewrite baseline storage");

  const secondMessage = {
    ...firstMessage,
    id: 102,
    headerMessageId: "second@example.test",
    subject: "Second"
  };
  storage[AUTO_BASELINES_KEY].work = {
    schemaVersion: 3,
    initializing: true,
    activatedAt: "2026-08-13T02:00:00.000Z",
    pendingHints: {}
  };
  assert.equal((await newMailListener.listener(inbox, {
    id: null,
    messages: [secondMessage]
  })).status, "disabled");
  assert.equal(
    storage[AUTO_BASELINES_KEY].work.pendingHints[messageFingerprint(secondMessage)],
    1
  );
  assert.equal(localWrites, 1, "activation hints must still be persisted");
});
