import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlan,
  buildAddressReport,
  buildArchivePlan,
  buildOrganizePlan
} from "../extension/lib/plans.js";
import {setupAllCustomerFolders} from "../extension/lib/folders.js";
import {messageFingerprint} from "../extension/lib/fingerprint.js";

function folders() {
  const root = {id: "root", accountId: "work", name: "Work", isRoot: true};
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const archive = {id: "organizer-archive", accountId: "work", name: "Organizer Archive", specialUse: []};
  root.subFolders = [inbox, archive];
  return {root, inbox, archive};
}

function config(overrides = {}) {
  return {
    revision: 3,
    maxMessagesPerRun: 25,
    preserveFlagged: true,
    scanSubject: true,
    scanBody: false,
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: true,
        archiveFolderName: "Organizer Archive",
        archiveReady: true,
        autoFileIncoming: false
      }
    },
    customers: [],
    ...overrides
  };
}

function archiveApi(messages) {
  const tree = folders();
  const moves = [];
  const api = {
    accounts: {
      get: async () => ({id: "work", name: "Work", rootFolder: tree.root})
    },
    folders: {
      getSubFolders: async id => id === "root" ? [tree.inbox, tree.archive] : [],
      getFolderCapabilities: async () => ({
        canAddMessages: true,
        canDeleteMessages: true
      }),
      getParentFolders: async () => [tree.root]
    },
    messages: {
      query: async () => ({id: null, messages}),
      get: async id => messages.find(message => message.id === id),
      move: async (ids, destinationId, options) => {
        moves.push({ids, destinationId, options});
      }
    }
  };
  return {api, moves, ...tree};
}

function bulkOrganizeApi(messages) {
  const tree = folders();
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: []
  };
  const customerFolder = {
    id: "acme-folder",
    accountId: "work",
    name: "Acme",
    specialUse: []
  };
  tree.root.subFolders = [tree.inbox, tree.archive, customerRoot];
  customerRoot.subFolders = [customerFolder];

  return {
    ...tree,
    customerRoot,
    customerFolder,
    api: {
      accounts: {
        get: async () => ({id: "work", name: "Work", rootFolder: tree.root})
      },
      folders: {
        getSubFolders: async folderId => {
          if (folderId === tree.root.id) return tree.root.subFolders;
          if (folderId === customerRoot.id) return customerRoot.subFolders;
          return [];
        },
        getFolderCapabilities: async () => ({canDeleteMessages: true}),
        getParentFolders: async folderId => {
          if (folderId === customerFolder.id) return [customerRoot, tree.root];
          return [tree.root];
        }
      },
      messages: {
        query: async () => ({id: null, messages})
      },
      messengerUtilities: {
        parseMailboxString: async value => {
          const match = String(value).match(/[\w.+-]+@[\w.-]+/u);
          return match ? [{email: match[0]}] : [];
        }
      }
    }
  };
}

function bulkOrganizeConfig(maxMessagesPerRun = 2) {
  return config({
    maxMessagesPerRun,
    customers: [{
      id: "acme",
      name: "Acme",
      folderName: "Acme",
      enabled: true,
      accountIds: [],
      domains: ["acme.com"],
      addresses: [],
      keywords: []
    }]
  });
}

function header(id, folder, overrides = {}) {
  return {
    id,
    headerMessageId: `<${id}@example.test>`,
    date: new Date("2026-08-12T12:00:00Z"),
    author: "Internal <engineer@google.com>",
    recipients: [],
    ccList: [],
    bccList: [],
    subject: "Status",
    folder,
    external: false,
    junk: false,
    flagged: false,
    ...overrides
  };
}

test("archive plans use the dedicated organizer folder and a normal move", async () => {
  const tree = folders();
  const message = header(7, tree.inbox);
  const {api, moves} = archiveApi([message]);
  const plan = await buildArchivePlan({accountId: "work", days: 0}, config(), api);
  const item = plan.items.find(candidate => candidate.action === "archive");

  assert.equal(item.destinationFolderId, "organizer-archive");
  const result = await applyPlan(plan, [item.id], config(), null, api);
  assert.equal(result.completed, 1);
  assert.deepEqual(moves, [{
    ids: [7],
    destinationId: "organizer-archive",
    options: {isUserAction: true}
  }]);
});

test("archive scanning reaches actionable mail beyond an initial skipped batch", async () => {
  const tree = folders();
  const messages = Array.from({length: 30}, (_, index) =>
    header(index + 1, tree.inbox, {flagged: true})
  );
  messages.push(header(99, tree.inbox));
  const {api} = archiveApi(messages);

  const plan = await buildArchivePlan({accountId: "work", days: 0}, config(), api);
  assert.equal(plan.summary.total, 31);
  assert.equal(plan.summary.actionable, 1);
  assert.ok(plan.items.some(item => item.messageId === 99 && item.action === "archive"));
  assert.equal(plan.truncated, true);
});

test("archive scanning has a hard examined-message budget", async () => {
  const tree = folders();
  const messages = Array.from({length: 200}, (_, index) =>
    header(index + 1, tree.inbox, {flagged: true})
  );
  messages.push(header(999, tree.inbox));
  const {api} = archiveApi(messages);

  const plan = await buildArchivePlan({accountId: "work", days: 0}, config(), api);
  assert.equal(plan.scanned, 125);
  assert.equal(plan.scanBudget, 125);
  assert.equal(plan.summary.actionable, 0);
  assert.equal(plan.truncated, true);
});

test("automatic filing ignores subject-only matches", async () => {
  const tree = folders();
  const message = header(1, tree.inbox, {subject: "Escalation for acme.com"});
  const customer = {
    id: "acme",
    name: "Acme",
    folderName: "Acme",
    enabled: true,
    accountIds: [],
    domains: ["acme.com"],
    addresses: [],
    keywords: []
  };
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: []
  };
  const api = {
    accounts: {
      get: async () => ({id: "work", name: "Work", rootFolder: tree.root})
    },
    folders: {
      getSubFolders: async id => id === "root" ? [tree.inbox, customerRoot] : [],
      getFolderCapabilities: async () => ({canDeleteMessages: true}),
      getParentFolders: async () => [tree.root]
    },
    messengerUtilities: {
      parseMailboxString: async value => {
        const match = String(value).match(/[\w.+-]+@[\w.-]+/u);
        return match ? [{email: match[0]}] : [];
      }
    }
  };
  const messageList = () => ({id: null, messages: [message]});
  const rules = config({customers: [customer]});

  const automatic = await buildOrganizePlan(
    {accountId: "work", days: 0, automatic: true, messageList: messageList()},
    rules,
    api
  );
  const manual = await buildOrganizePlan(
    {accountId: "work", days: 0, automatic: false, messageList: messageList()},
    rules,
    api
  );

  assert.equal(automatic.summary.actionable, 0);
  assert.equal(manual.summary.actionable, 1);
});

test("a first Apply persists ownership of the customer root for later previews and setup", async () => {
  const tree = folders();
  const account = {id: "work", name: "Work", rootFolder: tree.root};
  const customer = {
    id: "acme",
    name: "Acme",
    folderName: "Acme",
    enabled: true,
    accountIds: [],
    domains: ["acme.com"],
    addresses: [],
    keywords: []
  };
  const rules = config({
    accounts: {
      work: {
        enabled: true,
        rootFolderName: "Customers",
        customerRootReady: false,
        archiveFolderName: "Organizer Archive",
        archiveReady: true,
        autoFileIncoming: false
      }
    },
    customers: [customer]
  });
  const children = new Map([
    ["root", [tree.inbox, tree.archive]],
    ["inbox", []],
    ["organizer-archive", []]
  ]);
  const parentById = new Map([
    ["inbox", tree.root],
    ["organizer-archive", tree.root]
  ]);
  const allFolders = new Map([
    [tree.root.id, tree.root],
    [tree.inbox.id, tree.inbox],
    [tree.archive.id, tree.archive]
  ]);
  const messages = [header(1, tree.inbox, {author: "Owner <owner@acme.com>"})];
  let createdFolderNumber = 0;
  let persisted = 0;
  const api = {
    accounts: {
      get: async () => account
    },
    folders: {
      getSubFolders: async id => children.get(id) ?? [],
      getFolderCapabilities: async () => ({
        canAddMessages: true,
        canAddSubfolders: true,
        canDeleteMessages: true
      }),
      getParentFolders: async id => {
        const parents = [];
        let parent = parentById.get(id);
        while (parent) {
          parents.push(parent);
          parent = parentById.get(parent.id);
        }
        return parents;
      },
      create: async (parentId, name) => {
        const id = name === "Customers" ? "customers" : `created-${++createdFolderNumber}`;
        const folder = {id, accountId: "work", name, specialUse: []};
        children.set(parentId, [...(children.get(parentId) ?? []), folder]);
        children.set(id, []);
        parentById.set(id, allFolders.get(parentId));
        allFolders.set(id, folder);
        return folder;
      }
    },
    messages: {
      query: async query => ({
        id: null,
        messages: messages.filter(message => message.folder.id === query.folderId)
      }),
      get: async id => messages.find(message => message.id === id),
      move: async (ids, destinationId) => {
        for (const id of ids) {
          messages.find(message => message.id === id).folder = allFolders.get(destinationId);
        }
      }
    },
    messengerUtilities: {
      parseMailboxString: async value => {
        const match = String(value).match(/[\w.+-]+@[\w.-]+/u);
        return match ? [{email: match[0]}] : [];
      }
    }
  };

  const firstPlan = await buildOrganizePlan(
    {accountId: "work", source: "inbox", days: 0},
    rules,
    api
  );
  const firstItem = firstPlan.items.find(item => item.action === "move");
  assert.equal(firstItem.destinationExists, false);

  const result = await applyPlan(firstPlan, [firstItem.id], rules, null, api, {
    persistConfigState: async updatedConfig => {
      persisted += 1;
      assert.equal(updatedConfig.accounts.work.customerRootReady, true);
    }
  });
  assert.equal(result.completed, 1);
  assert.equal(result.customerRootCreated, true);
  assert.equal(rules.accounts.work.customerRootReady, true);
  assert.equal(persisted, 1);

  messages.push(header(2, tree.inbox, {author: "Owner <owner@acme.com>"}));
  const nextPlan = await buildOrganizePlan(
    {accountId: "work", source: "inbox", days: 0},
    rules,
    api
  );
  assert.equal(nextPlan.items.find(item => item.messageId === 2).destinationExists, true);

  const setup = await setupAllCustomerFolders(rules, [account], api);
  assert.deepEqual(setup.errors, []);
});

test("selected messages below Trash are skipped with one ancestry lookup per folder", async () => {
  const tree = folders();
  const child = {id: "trash-child", accountId: "work", name: "Imported", specialUse: []};
  const messages = [header(1, child), header(2, child)];
  let parentLookups = 0;
  const api = {
    accounts: {
      get: async () => ({id: "work", name: "Work", rootFolder: tree.root})
    },
    folders: {
      getSubFolders: async () => [],
      getFolderCapabilities: async () => ({canDeleteMessages: true}),
      getParentFolders: async () => {
        parentLookups += 1;
        return [{id: "trash", accountId: "work", specialUse: ["trash"]}, tree.root];
      }
    }
  };

  const plan = await buildOrganizePlan(
    {accountId: "work", days: 0, messageList: {id: null, messages}},
    config(),
    api
  );

  assert.equal(plan.summary.skipped, 2);
  assert.equal(parentLookups, 1);
});

test("address reports refuse a popup account mismatch", async () => {
  const activeFolder = {id: "customer", accountId: "other", name: "Acme"};
  const api = {
    mailTabs: {
      query: async () => [{displayedFolder: activeFolder}]
    },
    accounts: {
      get: async () => ({
        id: "other",
        name: "Other mailbox",
        rootFolder: {id: "other-root", accountId: "other", name: "Other"}
      })
    }
  };

  await assert.rejects(
    buildAddressReport({accountId: "work", days: 7}, config(), api),
    /not the account selected/u
  );
});

test("address reports use the same exact-domain ownership as filing", async () => {
  const root = {id: "root", accountId: "work", name: "Work", specialUse: []};
  const customerRoot = {id: "customers", accountId: "work", name: "Customers", specialUse: []};
  const hitachiFolder = {id: "hitachi", accountId: "work", name: "Hitachi", specialUse: []};
  const railFolder = {id: "rail", accountId: "work", name: "Rail", specialUse: []};
  root.subFolders = [customerRoot];
  customerRoot.subFolders = [hitachiFolder, railFolder];
  const messages = [header(1, railFolder, {
    author: "Rail <owner@rail.hitachi.com>",
    recipients: [
      "Deep Rail <engineer@team.rail.hitachi.com>",
      "Parent <person@unknown.hitachi.com>"
    ]
  })];
  const rules = config({
    customers: [
      {
        id: "hitachi",
        name: "Hitachi",
        folderName: "Hitachi",
        enabled: true,
        accountIds: [],
        domains: ["hitachi.com"],
        addresses: [],
        keywords: []
      },
      {
        id: "rail",
        name: "Rail",
        folderName: "Rail",
        enabled: true,
        accountIds: [],
        domains: ["rail.hitachi.com"],
        addresses: [],
        keywords: []
      }
    ]
  });
  const api = {
    mailTabs: {query: async () => [{displayedFolder: railFolder}]},
    accounts: {get: async () => ({id: "work", name: "Work", rootFolder: root})},
    folders: {
      getSubFolders: async folderId => {
        if (folderId === root.id) return [customerRoot];
        if (folderId === customerRoot.id) return [hitachiFolder, railFolder];
        return [];
      }
    },
    messages: {query: async () => ({id: null, messages})},
    messengerUtilities: {
      parseMailboxString: async value => {
        const match = String(value).match(/[\w.+-]+@[\w.-]+/u);
        return match ? [{email: match[0]}] : [];
      }
    }
  };

  const report = await buildAddressReport({accountId: "work", days: 7}, rules, api);

  assert.deepEqual(report.addresses.map(item => item.address), [
    "owner@rail.hitachi.com"
  ]);
});

test("bulk organize plans stop at the action limit and resume after previously examined occurrences", async () => {
  const messages = [];
  const {api, inbox} = bulkOrganizeApi(messages);
  messages.push(
    header(1, inbox, {author: "Internal <one@google.com>"}),
    header(2, inbox, {author: "Customer <two@acme.com>"}),
    header(3, inbox, {author: "Customer <three@acme.com>"}),
    header(4, inbox, {author: "Internal <four@google.com>"}),
    header(5, inbox, {author: "Customer <five@acme.com>"})
  );
  const rules = bulkOrganizeConfig(2);
  const firstBulk = {sessionId: "bulk-session", batchNumber: 1, examinedCounts: {}};

  const first = await buildOrganizePlan(
    {accountId: "work", source: "inbox", days: 0, bulk: firstBulk},
    rules,
    api
  );

  assert.equal(first.stopReason, "action-limit");
  assert.equal(first.scanComplete, false);
  assert.equal(first.summary.actionable, 2);
  assert.deepEqual(
    first.items.filter(item => item.action).map(item => item.messageId),
    [2, 3]
  );
  assert.deepEqual(first.bulkExaminedCounts, {
    [messageFingerprint(messages[0])]: 1,
    [messageFingerprint(messages[1])]: 1,
    [messageFingerprint(messages[2])]: 1
  });
  assert.deepEqual(firstBulk, {
    sessionId: "bulk-session",
    batchNumber: 1,
    examinedCounts: {}
  });

  const second = await buildOrganizePlan(
    {
      accountId: "work",
      source: "inbox",
      days: 0,
      bulk: {
        sessionId: firstBulk.sessionId,
        batchNumber: 2,
        examinedCounts: first.bulkExaminedCounts
      }
    },
    rules,
    api
  );

  assert.equal(second.stopReason, null);
  assert.equal(second.scanComplete, true);
  assert.equal(second.scanned, 2);
  assert.deepEqual(
    second.items.filter(item => item.action).map(item => item.messageId),
    [5]
  );
  assert.deepEqual(second.bulkExaminedCounts, {
    [messageFingerprint(messages[3])]: 1,
    [messageFingerprint(messages[4])]: 1
  });
});

test("bulk organize plans advance beyond a non-actionable scan-budget prefix", async () => {
  const messages = [];
  const {api, inbox} = bulkOrganizeApi(messages);
  messages.push(
    ...Array.from({length: 10}, (_, index) =>
      header(index + 1, inbox, {author: `Internal <person${index + 1}@google.com>`})
    ),
    header(11, inbox, {author: "Customer <owner@acme.com>"})
  );
  const rules = bulkOrganizeConfig(2);

  const first = await buildOrganizePlan(
    {
      accountId: "work",
      source: "inbox",
      days: 0,
      bulk: {sessionId: "budget-session", batchNumber: 1, examinedCounts: {}}
    },
    rules,
    api
  );

  assert.equal(first.scanned, 10);
  assert.equal(first.scanBudget, 10);
  assert.equal(first.stopReason, "scan-budget");
  assert.equal(first.scanComplete, false);
  assert.equal(first.summary.actionable, 0);
  assert.equal(Object.values(first.bulkExaminedCounts).reduce((sum, count) => sum + count, 0), 10);

  const second = await buildOrganizePlan(
    {
      accountId: "work",
      source: "inbox",
      days: 0,
      bulk: {
        sessionId: "budget-session",
        batchNumber: 2,
        examinedCounts: first.bulkExaminedCounts
      }
    },
    rules,
    api
  );

  assert.equal(second.scanned, 1);
  assert.equal(second.stopReason, null);
  assert.equal(second.scanComplete, true);
  assert.deepEqual(
    second.items.filter(item => item.action).map(item => item.messageId),
    [11]
  );
});

test("sampled diagnostic rows do not make an exhausted bulk scan incomplete", async () => {
  const messages = [];
  const {api, inbox} = bulkOrganizeApi(messages);
  messages.push(...Array.from({length: 5}, (_, index) =>
    header(index + 1, inbox, {author: `Internal <person${index + 1}@google.com>`})
  ));

  const plan = await buildOrganizePlan(
    {
      accountId: "work",
      source: "inbox",
      days: 0,
      bulk: {sessionId: "sample-session", batchNumber: 1, examinedCounts: {}}
    },
    bulkOrganizeConfig(2),
    api
  );

  assert.equal(plan.scanned, 5);
  assert.equal(plan.rowsSampled, true);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.stopReason, null);
  assert.equal(plan.scanComplete, true);
  assert.equal(plan.truncated, true);
  assert.equal(Object.values(plan.bulkExaminedCounts).reduce((sum, count) => sum + count, 0), 5);
});
