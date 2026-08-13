import test from "node:test";
import assert from "node:assert/strict";

import {createAutomaticFiler} from "../extension/lib/automatic.js";
import {accountMessageFingerprint} from "../extension/lib/fingerprint.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
}

function baseConfig(overrides = {}) {
  const account = {
    enabled: true,
    rootFolderName: "Customers",
    customerRootReady: true,
    archiveFolderName: "Organizer Archive",
    archiveReady: false,
    autoFileIncoming: true,
    ...(overrides.account ?? {})
  };
  return {
    revision: 1,
    maxMessagesPerRun: overrides.maxMessagesPerRun ?? 25,
    preserveFlagged: true,
    scanSubject: true,
    scanBody: false,
    accounts: {work: account},
    customers: overrides.customers ?? [{
      id: "acme",
      name: "Acme",
      folderName: "Acme",
      enabled: true,
      accountIds: [],
      domains: ["acme.com"],
      addresses: [],
      keywords: []
    }]
  };
}

function header(id, folder, overrides = {}) {
  return {
    id,
    headerMessageId: `<${id}@example.test>`,
    date: new Date("2026-08-12T12:00:00Z"),
    author: `Customer ${id} <person${id}@acme.com>`,
    recipients: [],
    ccList: [],
    bccList: [],
    subject: `Customer update ${id}`,
    folder,
    external: false,
    junk: false,
    flagged: false,
    ...overrides
  };
}

function mailbox({destinationExists = true, messageCount = 1, maxMessagesPerRun = 25} = {}) {
  const accountRoot = {
    id: "account-root",
    accountId: "work",
    name: "Work",
    specialUse: []
  };
  const inbox = {
    id: "inbox",
    accountId: "work",
    name: "Inbox",
    specialUse: ["inbox"]
  };
  const customerRoot = {
    id: "customers",
    accountId: "work",
    name: "Customers",
    specialUse: []
  };
  const destination = destinationExists
    ? {
        id: "acme-folder",
        accountId: "work",
        name: "Acme",
        specialUse: []
      }
    : null;

  accountRoot.subFolders = [inbox, customerRoot];
  customerRoot.subFolders = destination ? [destination] : [];
  inbox.subFolders = [];
  if (destination) destination.subFolders = [];

  const folders = new Map([
    [accountRoot.id, accountRoot],
    [inbox.id, inbox],
    [customerRoot.id, customerRoot]
  ]);
  const children = new Map([
    [accountRoot.id, [inbox, customerRoot]],
    [inbox.id, []],
    [customerRoot.id, destination ? [destination] : []]
  ]);
  const parentById = new Map([
    [inbox.id, accountRoot],
    [customerRoot.id, accountRoot]
  ]);
  if (destination) {
    folders.set(destination.id, destination);
    children.set(destination.id, []);
    parentById.set(destination.id, customerRoot);
  }

  const messages = Array.from({length: messageCount}, (_, index) =>
    header(index + 1, inbox)
  );
  const messagesById = new Map(messages.map(message => [message.id, message]));
  const continuationPages = new Map();
  const creates = [];
  const moves = [];
  let createdFolderNumber = 0;

  const api = {
    accounts: {
      get: async accountId => {
        assert.equal(accountId, "work");
        return {id: "work", name: "Work", rootFolder: accountRoot};
      }
    },
    folders: {
      getSubFolders: async folderId => children.get(folderId) ?? [],
      getFolderCapabilities: async folderId => ({
        canAddMessages: folderId !== customerRoot.id,
        canAddSubfolders: true,
        canDeleteMessages: folderId === inbox.id
      }),
      getParentFolders: async folderId => {
        const parents = [];
        let parent = parentById.get(folderId);
        while (parent) {
          parents.push(parent);
          parent = parentById.get(parent.id);
        }
        return parents;
      },
      create: async (parentId, name) => {
        const created = {
          id: `created-${++createdFolderNumber}`,
          accountId: "work",
          name,
          specialUse: [],
          subFolders: []
        };
        creates.push({parentId, name, folder: created});
        folders.set(created.id, created);
        children.set(parentId, [...(children.get(parentId) ?? []), created]);
        children.set(created.id, []);
        parentById.set(created.id, folders.get(parentId));
        return created;
      }
    },
    messages: {
      continueList: async pageId => {
        assert.ok(continuationPages.has(pageId), `Unexpected continuation page ${pageId}`);
        return continuationPages.get(pageId);
      },
      get: async messageId => {
        const message = messagesById.get(messageId);
        if (!message) throw new Error(`Message ${messageId} is unavailable`);
        return message;
      },
      move: async (messageIds, destinationId, options) => {
        const target = folders.get(destinationId);
        assert.ok(target, `Unknown destination ${destinationId}`);
        moves.push({messageIds: [...messageIds], destinationId, options});
        for (const messageId of messageIds) {
          messagesById.get(messageId).folder = target;
        }
      },
      query: async query => ({
        id: null,
        messages: messages.filter(message =>
          message.folder.id === query.folderId &&
          (!query.headerMessageId || message.headerMessageId === query.headerMessageId)
        )
      })
    },
    messengerUtilities: {
      parseMailboxString: async value => {
        const match = String(value).match(/[\w.+-]+@[\w.-]+/u);
        return match ? [{email: match[0]}] : [];
      }
    }
  };

  return {
    api,
    config: baseConfig({maxMessagesPerRun}),
    accountRoot,
    inbox,
    customerRoot,
    destination,
    messages,
    continuationPages,
    creates,
    moves
  };
}

function automaticFiler({
  api,
  config,
  buildPlan,
  apply,
  captureContacts,
  confirmMove,
  loadSuppressions,
  mutateSuppressions,
  recordArrivalHints,
  markKnown,
  consumeArrivalHint,
  runExclusive = (_accountId, operation) => operation()
}) {
  const lastRuns = [];
  const persistedConfigs = [];
  const dependencies = {
    api,
    loadState: async () => ({config}),
    saveLastRun: async value => lastRuns.push(value),
    runExclusive,
    persistConfigState: async value => persistedConfigs.push(value)
  };
  if (loadSuppressions) dependencies.loadSuppressions = loadSuppressions;
  if (mutateSuppressions) dependencies.mutateSuppressions = mutateSuppressions;
  if (recordArrivalHints) dependencies.recordArrivalHints = recordArrivalHints;
  if (markKnown) dependencies.markKnown = markKnown;
  if (consumeArrivalHint) dependencies.consumeArrivalHint = consumeArrivalHint;
  if (buildPlan) dependencies.buildPlan = buildPlan;
  if (apply) dependencies.apply = apply;
  if (captureContacts) dependencies.captureContacts = captureContacts;
  if (confirmMove) dependencies.confirmMove = confirmMove;
  return {
    filer: createAutomaticFiler(dependencies),
    lastRuns,
    persistedConfigs
  };
}

function completedResult(plan) {
  const results = plan.items
    .filter(item => item.action)
    .map(item => ({itemId: item.id, status: "completed"}));
  return {
    attempted: results.length,
    completed: results.length,
    failed: 0,
    customerRootCreated: false,
    results
  };
}

function movePlan(messages, inboxId = "inbox") {
  return {
    id: "automatic-contact-plan",
    kind: "organize",
    accountId: "work",
    accountName: "Work",
    summary: {ambiguous: 0, skipped: 0},
    items: messages.map(message => ({
      id: `item-${message.id}`,
      action: "move",
      messageId: message.id,
      headerMessageId: message.headerMessageId,
      sourceFolderId: inboxId,
      destinationFolderId: "acme-folder",
      customerId: "acme",
      customerName: "Acme",
      subject: message.subject,
      author: message.author
    }))
  };
}

test("automatic filing materializes every page and is not capped by the preview limit", async () => {
  const box = mailbox({destinationExists: true, messageCount: 5, maxMessagesPerRun: 2});
  box.continuationPages.set("page-2", {
    id: null,
    messages: box.messages.slice(2)
  });
  const firstPage = {
    id: "page-2",
    messages: box.messages.slice(0, 2)
  };
  const {filer, lastRuns} = automaticFiler({api: box.api, config: box.config});

  const result = await filer.handleNewMail(box.inbox, firstPage);

  assert.equal(result.status, "complete");
  assert.equal(result.attempted, 5);
  assert.deepEqual(
    box.moves.flatMap(move => move.messageIds),
    [1, 2, 3, 4, 5]
  );
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].attempted, 5);
});

test("automatic filing creates one missing customer folder and confirms every move", async () => {
  const box = mailbox({destinationExists: false, messageCount: 2});
  const confirmations = [];
  const suppressions = {};
  const {filer, lastRuns} = automaticFiler({
    api: box.api,
    config: box.config,
    mutateSuppressions: async mutator => mutator(suppressions),
    confirmMove: async (descriptor, operation) => {
      confirmations.push(descriptor);
      await operation();
      return {status: "moved"};
    }
  });

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.equal(result.status, "complete");
  assert.deepEqual(
    box.creates.map(({parentId, name}) => ({parentId, name})),
    [{parentId: box.customerRoot.id, name: "Acme"}]
  );
  assert.equal(box.moves.length, 2);
  assert.ok(box.moves.every(move => move.destinationId === box.creates[0].folder.id));
  assert.deepEqual(confirmations.map(({item: _item, ...descriptor}) => descriptor), [
    {
      messageId: 1,
      sourceFolderId: box.inbox.id,
      destinationFolderId: box.creates[0].folder.id
    },
    {
      messageId: 2,
      sourceFolderId: box.inbox.id,
      destinationFolderId: box.creates[0].folder.id
    }
  ]);
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].completed, 2);
  assert.equal(Object.keys(suppressions).length, 2);
  assert.ok(Object.values(suppressions).every(attempt => attempt.state === "confirmed"));
});

test("contact capture runs once after apply with only successfully moved mail", async () => {
  const box = mailbox({destinationExists: true, messageCount: 2});
  const events = [];
  const captured = [];
  const plan = movePlan(box.messages, box.inbox.id);
  const {filer, lastRuns} = automaticFiler({
    api: box.api,
    config: box.config,
    buildPlan: async () => plan,
    apply: async () => {
      events.push("apply");
      return {
        attempted: 2,
        completed: 1,
        failed: 1,
        customerRootCreated: false,
        results: [
          {
            itemId: "item-1",
            status: "completed",
            destinationFolderId: "acme-folder"
          },
          {itemId: "item-2", status: "failed", error: "simulated move failure"}
        ]
      };
    },
    captureContacts: async context => {
      events.push("capture");
      captured.push(context);
      return {attempted: 2, created: 1, existing: 1, failed: 0};
    }
  });

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.deepEqual(events, ["apply", "capture"]);
  assert.equal(captured.length, 1);
  assert.deepEqual(Object.keys(captured[0]).sort(), ["accountId", "completed", "config"]);
  assert.equal(captured[0].accountId, "work");
  assert.equal(captured[0].config, box.config);
  assert.equal(captured[0].completed.length, 1);
  assert.equal(captured[0].completed[0].message, box.messages[0]);
  assert.equal(captured[0].completed[0].item, plan.items[0]);
  assert.deepEqual(captured[0].completed[0].result, {
    itemId: "item-1",
    status: "completed",
    destinationFolderId: "acme-folder"
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results.map(item => item.itemId), ["item-1", "item-2"]);
  assert.deepEqual(result.contacts, {
    attempted: 2,
    created: 1,
    existing: 1,
    failed: 0
  });
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].contactsAttempted, 2);
  assert.equal(lastRuns[0].contactsCreated, 1);
  assert.equal(lastRuns[0].contactsExisting, 1);
  assert.equal(lastRuns[0].contactsFailed, 0);
});

test("contact capture is skipped when no mail matches or every move fails", async () => {
  const noMatchBox = mailbox({destinationExists: true, messageCount: 1});
  noMatchBox.messages[0].author = "Newsletter <news@unrelated.example>";
  let noMatchCaptureCalls = 0;
  const noMatchFiler = automaticFiler({
    api: noMatchBox.api,
    config: noMatchBox.config,
    captureContacts: async () => {
      noMatchCaptureCalls += 1;
      return {attempted: 0, created: 0, existing: 0, failed: 0};
    }
  }).filer;

  const noMatchResult = await noMatchFiler.handleNewMail(noMatchBox.inbox, {
    id: null,
    messages: noMatchBox.messages
  });

  const failedBox = mailbox({destinationExists: true, messageCount: 1});
  let failedCaptureCalls = 0;
  const failedFiler = automaticFiler({
    api: failedBox.api,
    config: failedBox.config,
    buildPlan: async () => movePlan(failedBox.messages, failedBox.inbox.id),
    apply: async () => ({
      attempted: 1,
      completed: 0,
      failed: 1,
      customerRootCreated: false,
      results: [{itemId: "item-1", status: "failed", error: "move rejected"}]
    }),
    captureContacts: async () => {
      failedCaptureCalls += 1;
      return {attempted: 0, created: 0, existing: 0, failed: 0};
    }
  }).filer;

  const failedResult = await failedFiler.handleNewMail(failedBox.inbox, {
    id: null,
    messages: failedBox.messages
  });

  assert.equal(noMatchResult.status, "no-match");
  assert.equal(noMatchCaptureCalls, 0);
  assert.equal(failedResult.status, "failed");
  assert.equal(failedCaptureCalls, 0);
});

test("a contact-capture failure never retries or reverses a successful move", async () => {
  const box = mailbox({destinationExists: true, messageCount: 1});
  let captureCalls = 0;
  const {filer, lastRuns} = automaticFiler({
    api: box.api,
    config: box.config,
    captureContacts: async () => {
      captureCalls += 1;
      throw new Error("address book unavailable");
    }
  });

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.equal(result.status, "complete");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(captureCalls, 1);
  assert.equal(box.moves.length, 1);
  assert.deepEqual(box.moves[0].messageIds, [1]);
  assert.deepEqual(result.contacts, {
    attempted: 0,
    created: 0,
    existing: 0,
    failed: 1
  });
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].completed, 1);
  assert.equal(lastRuns[0].failed, 0);
  assert.equal(lastRuns[0].contactsFailed, 1);
  assert.match(lastRuns[0].error, /Customer contact capture failed: address book unavailable/u);
});

test("automatic filing refuses to create an unapproved customer root", async () => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const config = baseConfig({account: {customerRootReady: false}});
  let buildCalls = 0;
  let applyCalls = 0;
  const {filer, lastRuns} = automaticFiler({
    api: {messages: {}},
    config,
    buildPlan: async () => {
      buildCalls += 1;
      return {
        accountName: "Work",
        summary: {ambiguous: 0, skipped: 0},
        items: [{id: "item-1", action: "move"}]
      };
    },
    apply: async () => {
      applyCalls += 1;
      return {attempted: 0, completed: 0, failed: 0, results: []};
    }
  });

  await filer.handleNewMail(inbox, {id: null, messages: [header(1, inbox)]});

  assert.equal(buildCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].accountName, "Work");
  assert.equal(lastRuns[0].attempted, 1);
  assert.equal(lastRuns[0].failed, 1);
  assert.match(lastRuns[0].error, /set up folders/u);
});

test("automatic filing journals a move before invocation and retains uncertainty for review", async () => {
  const box = mailbox({destinationExists: true, messageCount: 1});
  const suppressions = {};
  let journalObservedBeforeMove = false;
  const {filer} = automaticFiler({
    api: box.api,
    config: box.config,
    mutateSuppressions: async mutator => mutator(suppressions),
    confirmMove: async (_descriptor, operation) => {
      journalObservedBeforeMove = Object.values(suppressions).some(
        entry => entry.state === "attempting"
      );
      await operation();
      const error = new Error("Move outcome was not confirmed");
      error.automaticMoveIndeterminate = true;
      throw error;
    }
  });

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.equal(journalObservedBeforeMove, true);
  assert.equal(result.status, "failed");
  assert.equal(box.moves.length, 1);
  const [attempt] = Object.values(suppressions);
  assert.equal(attempt.state, "review");
  assert.match(attempt.reason, /not confirmed/u);
});

test("automatic filing routes an explicitly configured sister-company domain", async () => {
  const box = mailbox({destinationExists: false, messageCount: 1});
  box.config.customers = [
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
  ];
  box.messages[0].author = "Rail Engineer <engineer@rail.hitachi.com>";
  const {filer} = automaticFiler({api: box.api, config: box.config});

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.equal(result.status, "complete");
  assert.deepEqual(box.creates.map(({parentId, name}) => ({parentId, name})), [
    {parentId: box.customerRoot.id, name: "Rail"}
  ]);
});

test("automatic filing leaves an unconfigured subdomain in Inbox", async () => {
  const box = mailbox({destinationExists: false, messageCount: 1});
  box.config.customers = [{
    id: "shutterfly",
    name: "Shutterfly",
    folderName: "Shutterfly",
    enabled: true,
    accountIds: [],
    domains: ["shutterfly.com"],
    addresses: [],
    keywords: []
  }];
  box.messages[0].author = "Shutterfly <Shutterfly@em.shutterfly.com>";
  const {filer} = automaticFiler({api: box.api, config: box.config});

  const result = await filer.handleNewMail(box.inbox, {id: null, messages: box.messages});

  assert.equal(result.status, "no-match");
  assert.equal(box.creates.length, 0);
  assert.equal(box.moves.length, 0);
});

test("a non-Inbox event is fully drained before it is ignored", async () => {
  const sent = {id: "sent", accountId: "work", name: "Sent", specialUse: ["sent"]};
  const continuationRequested = deferred();
  const releaseContinuation = deferred();
  let runExclusiveCalls = 0;
  const api = {
    messages: {
      continueList: async pageId => {
        assert.equal(pageId, "sent-page-2");
        continuationRequested.resolve();
        return releaseContinuation.promise;
      }
    }
  };
  const {filer} = automaticFiler({
    api,
    config: baseConfig(),
    runExclusive: async () => {
      runExclusiveCalls += 1;
      throw new Error("A non-Inbox event must not enter the mutation queue");
    }
  });
  let settled = false;
  const pending = filer
    .handleNewMail(sent, {id: "sent-page-2", messages: [header(1, sent)]})
    .then(result => {
      settled = true;
      return result;
    });

  await continuationRequested.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  releaseContinuation.resolve({id: null, messages: [header(2, sent)]});

  const result = await pending;
  assert.equal(result.status, "ignored");
  assert.equal(runExclusiveCalls, 0);
});

test("simultaneous Inbox events drain immediately and apply in FIFO order", async () => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const first = header("first", inbox);
  const second = header("second", inbox);
  const secondTail = header("second-tail", inbox);
  const firstApplyStarted = deferred();
  const releaseFirstApply = deferred();
  const secondListDrained = deferred();
  const buildOrder = [];
  const applyOrder = [];
  let queue = Promise.resolve();
  const runExclusive = (_accountId, operation) => {
    const queued = queue.catch(() => {}).then(operation);
    queue = queued;
    return queued;
  };
  const api = {
    messages: {
      continueList: async pageId => {
        assert.equal(pageId, "second-page-2");
        secondListDrained.resolve();
        return {id: null, messages: [secondTail]};
      }
    }
  };
  const buildPlan = async request => {
    const batch = request.messageList.messages.map(message => message.id).join(",");
    buildOrder.push(batch);
    return {
      id: `plan-${batch}`,
      kind: "organize",
      accountId: "work",
      accountName: "Work",
      items: request.messageList.messages.map(message => ({
        id: `item-${message.id}`,
        action: "move"
      }))
    };
  };
  const apply = async plan => {
    applyOrder.push(plan.id);
    if (plan.id === "plan-first") {
      firstApplyStarted.resolve();
      await releaseFirstApply.promise;
    }
    return completedResult(plan);
  };
  const {filer, lastRuns} = automaticFiler({
    api,
    config: baseConfig(),
    buildPlan,
    apply,
    runExclusive
  });

  const firstPending = filer.handleNewMail(inbox, {id: null, messages: [first]});
  const secondPending = filer.handleNewMail(inbox, {
    id: "second-page-2",
    messages: [second]
  });

  await Promise.all([firstApplyStarted.promise, secondListDrained.promise]);
  assert.deepEqual(buildOrder, ["first"]);
  assert.deepEqual(applyOrder, ["plan-first"]);

  releaseFirstApply.resolve();
  const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);

  assert.equal(firstResult.status, "complete");
  assert.equal(secondResult.status, "complete");
  assert.deepEqual(buildOrder, ["first", "second,second-tail"]);
  assert.deepEqual(applyOrder, ["plan-first", "plan-second,second-tail"]);
  assert.equal(lastRuns.length, 2);
});

test("a queued continuation failure is observed immediately and still reaches the caller", async () => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const queueGate = deferred();
  const continuationCalled = deferred();
  const failure = new Error("continuation expired");
  const api = {
    messages: {
      continueList: async () => {
        continuationCalled.resolve();
        throw failure;
      },
      abortList: async () => {}
    }
  };
  const {filer} = automaticFiler({
    api,
    config: baseConfig(),
    runExclusive: async (_accountId, operation) => {
      await queueGate.promise;
      return operation();
    }
  });

  const pending = filer.handleNewMail(inbox, {
    id: "expired-page",
    messages: [header(1, inbox)]
  });
  await continuationCalled.promise;
  await Promise.resolve();
  queueGate.resolve();

  await assert.rejects(pending, error => error === failure);
});

test("a partial automatic apply is reported once and never reconciled or replayed", async () => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const messages = [header(1, inbox), header(2, inbox)];
  let buildCalls = 0;
  let applyCalls = 0;
  let reconciliationLookups = 0;
  const api = {
    messages: {
      get: async messageId => {
        reconciliationLookups += 1;
        return messages.find(message => message.id === messageId);
      },
      query: async () => {
        reconciliationLookups += 1;
        return {id: null, messages: []};
      }
    }
  };
  const buildPlan = async request => {
    buildCalls += 1;
    return {
      id: `automatic-${buildCalls}`,
      kind: "organize",
      accountId: "work",
      accountName: "Work",
      items: request.messageList.messages.map(message => ({
        id: `item-${message.id}`,
        action: "move",
        messageId: message.id,
        headerMessageId: message.headerMessageId,
        sourceFolderId: inbox.id,
        destinationFolderId: "acme-folder",
        subject: message.subject,
        author: message.author
      }))
    };
  };
  const apply = async (_plan, _selected, _config, _notify, _api, options) => {
    applyCalls += 1;
    if (applyCalls === 1) {
      assert.equal(options.createFolders, true);
      assert.equal(options.liveDestinations, true);
      assert.equal(options.requireInboxSource, true);
      assert.equal(options.requireDefiniteMove, true);
      assert.equal(options.allowSubject, false);
      assert.equal(options.allowBody, false);
      assert.equal(options.isUserAction, false);
      return {
        attempted: 2,
        completed: 1,
        failed: 1,
        customerRootCreated: false,
        results: [
          {itemId: "item-1", status: "completed", destinationFolderId: "acme-folder"},
          {itemId: "item-2", status: "failed", error: "simulated move failure"}
        ]
      };
    }
    return {
      attempted: 1,
      completed: 1,
      failed: 0,
      customerRootCreated: false,
      results: [{itemId: "item-2", status: "completed"}]
    };
  };
  const {filer, lastRuns} = automaticFiler({
    api,
    config: baseConfig(),
    buildPlan,
    apply
  });

  const result = await filer.handleNewMail(inbox, {id: null, messages});

  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(buildCalls, 1);
  assert.equal(applyCalls, 1);
  assert.equal(reconciliationLookups, 0);
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].completed, 1);
  assert.equal(lastRuns[0].failed, 1);
  assert.match(lastRuns[0].error, /simulated move failure/u);
  assert.deepEqual(result.results, [
    {itemId: "item-1", status: "completed", destinationFolderId: "acme-folder"},
    {itemId: "item-2", status: "failed", error: "simulated move failure"}
  ]);
});

test("a prior indeterminate move is durably suppressed on later reconciliation", async () => {
  const inbox = {id: "inbox", accountId: "work", name: "Inbox", specialUse: ["inbox"]};
  const message = header(1, inbox);
  const suppressions = {
    [accountMessageFingerprint("work", message)]: {
      accountId: "work",
      headerMessageId: message.headerMessageId,
      reason: "Move confirmation timed out",
      createdAt: "2026-08-12T18:00:00.000Z"
    }
  };
  let applyCalls = 0;
  const {filer} = automaticFiler({
    api: {messages: {}},
    config: baseConfig(),
    loadSuppressions: async () => suppressions,
    buildPlan: async () => ({
      id: "reconcile",
      kind: "organize",
      accountId: "work",
      accountName: "Work",
      summary: {ambiguous: 0, skipped: 0},
      items: [{
        id: "item-1",
        action: "move",
        headerMessageId: message.headerMessageId,
        date: message.date.toISOString(),
        author: message.author,
        subject: message.subject
      }]
    }),
    apply: async () => {
      applyCalls += 1;
      return {attempted: 1, completed: 1, failed: 0, results: []};
    }
  });

  const result = await filer.handleNewMail(inbox, {id: null, messages: [message]});

  assert.equal(result.status, "no-match");
  assert.equal(applyCalls, 0);
  assert.equal(result.plan.items[0].status, "skipped");
  assert.match(result.plan.items[0].reason, /indeterminate/u);
});
