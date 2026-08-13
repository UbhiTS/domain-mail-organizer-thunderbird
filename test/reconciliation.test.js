import test from "node:test";
import assert from "node:assert/strict";

import {messageFingerprint} from "../extension/lib/fingerprint.js";
import {
  createInboxReconciler,
  selectReconciliationCandidates
} from "../extension/lib/reconciliation.js";

function message(id, folder, date = "2026-08-12T18:00:00.000Z", overrides = {}) {
  return {
    id,
    headerMessageId: `<${id}@example.test>`,
    date: new Date(date),
    author: `Sender ${id} <sender${id}@example.test>`,
    recipients: [],
    ccList: [],
    bccList: [],
    subject: `Message ${id}`,
    size: 100 + Number(id || 0),
    folder,
    ...overrides
  };
}

function baseline(activatedAt = "2026-08-12T17:00:00.000Z") {
  return {schemaVersion: 3, activatedAt, counts: {}, hints: {}, reviews: {}};
}

function inMemoryMutation(state) {
  return async mutator => (await mutator(state))?.result;
}

test("periodic reconciliation scans the complete enabled Inbox and files unseen mail", async () => {
  const workInbox = {id: "work-inbox", accountId: "work", specialUse: ["inbox"]};
  const offInbox = {id: "off-inbox", accountId: "off", specialUse: ["inbox"]};
  const accounts = [
    {id: "work", name: "Work", rootFolder: {id: "work-root", subFolders: [workInbox]}},
    {id: "off", name: "Off", rootFolder: {id: "off-root", subFolders: [offInbox]}}
  ];
  const config = {accounts: {
    work: {enabled: true, autoFileIncoming: true, autoFileSince: "2026-08-12T17:00:00.000Z"},
    off: {enabled: true, autoFileIncoming: false}
  }};
  const existing = message(1, workInbox, "2026-08-01T12:00:00.000Z");
  const arrival = message(2, workInbox);
  const baselines = {work: baseline()};
  baselines.work.counts[messageFingerprint(existing)] = 1;
  const listCalls = [];
  const filings = [];
  const reconciler = createInboxReconciler({
    api: {messages: {list: folderId => {
      listCalls.push(folderId);
      return {id: null, messages: [existing, arrival]};
    }}},
    loadState: async () => ({accounts, config}),
    mutateBaselines: inMemoryMutation(baselines),
    automaticFiler: {handleNewMail: async (folder, page, options) => {
      filings.push({folder, page, options});
      return {status: "complete"};
    }}
  });

  const results = await reconciler.reconcileAll();

  assert.deepEqual(listCalls, [workInbox.id]);
  assert.equal(filings.length, 1);
  assert.deepEqual(filings[0].page.messages.map(item => item.id), [arrival.id]);
  assert.deepEqual(filings[0].options, {
    recordArrival: false,
    respectSuppressions: false
  });
  assert.deepEqual(results.map(result => result.status), ["complete", "disabled"]);
});

test("overlapping reconciliation triggers coalesce into one full Inbox scan", async () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const accounts = [{id: "work", name: "Work", rootFolder: {id: "root", subFolders: [inbox]}}];
  const config = {accounts: {work: {
    enabled: true,
    autoFileIncoming: true,
    autoFileSince: "2026-08-12T17:00:00.000Z"
  }}};
  let scans = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reconciler = createInboxReconciler({
    api: {messages: {list: async () => {
      scans += 1;
      await gate;
      return {id: null, messages: []};
    }}},
    loadState: async () => ({accounts, config}),
    mutateBaselines: inMemoryMutation({work: baseline()}),
    automaticFiler: {handleNewMail: async () => ({status: "complete"})}
  });

  const first = reconciler.reconcileAll();
  const second = reconciler.reconcileAll();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(scans, 1);
});

test("scan-only old-dated discoveries are held for review, not silently moved", () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const oldArrival = message(7, inbox, "2020-01-01T00:00:00.000Z");
  const state = baseline();

  const selection = selectReconciliationCandidates({
    baseline: state,
    messages: [oldArrival],
    suppressions: {},
    accountId: "work",
    activationTime: Date.parse(state.activatedAt)
  });

  assert.deepEqual(selection.candidates, []);
  assert.deepEqual(selection.oldDateReview, [oldArrival]);
  assert.equal(state.counts[messageFingerprint(oldArrival)], 1);
  assert.match(
    state.reviews[messageFingerprint(oldArrival)].reason,
    /old-dated message/iu
  );
});

test("identical old-dated discoveries retain a review occurrence count", () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const first = message(7, inbox, "2020-01-01T00:00:00.000Z");
  const duplicate = {...first, id: 8};
  const state = baseline();

  selectReconciliationCandidates({
    baseline: state,
    messages: [first, duplicate],
    suppressions: {},
    accountId: "work",
    activationTime: Date.parse(state.activatedAt)
  });

  assert.equal(state.reviews[messageFingerprint(first)].count, 2);

  selectReconciliationCandidates({
    baseline: state,
    messages: [first],
    suppressions: {},
    accountId: "work",
    activationTime: Date.parse(state.activatedAt)
  });
  assert.equal(state.reviews[messageFingerprint(first)].count, 1);
});

test("an event hint makes old-dated mail eligible after an interrupted event turn", () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const oldArrival = message(8, inbox, "2020-01-01T00:00:00.000Z");
  const state = baseline();
  state.hints[messageFingerprint(oldArrival)] = 1;

  const selection = selectReconciliationCandidates({
    baseline: state,
    messages: [oldArrival],
    suppressions: {},
    accountId: "work",
    activationTime: Date.parse(state.activatedAt)
  });

  assert.deepEqual(selection.candidates, [oldArrival]);
  assert.deepEqual(selection.oldDateReview, []);
});

test("a durable uncertain attempt claims the Inbox occurrence before known mail", () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const uncertain = message(9, inbox);
  const fingerprint = messageFingerprint(uncertain);
  const state = baseline();
  state.counts[fingerprint] = 1;
  const suppressions = {
    attempt: {accountId: "work", inboxFingerprint: fingerprint, state: "review"}
  };

  const selection = selectReconciliationCandidates({
    baseline: state,
    messages: [uncertain],
    suppressions,
    accountId: "work",
    activationTime: Date.parse(state.activatedAt)
  });

  assert.deepEqual(selection.candidates, []);
  assert.equal(state.counts[fingerprint], undefined);
});

test("reconciliation releases only excess identical attempt claims", async () => {
  const inbox = {id: "inbox", accountId: "work", specialUse: ["inbox"]};
  const current = message(10, inbox);
  const fingerprint = messageFingerprint(current);
  const accounts = [{id: "work", name: "Work", rootFolder: {id: "root", subFolders: [inbox]}}];
  const config = {accounts: {work: {
    enabled: true,
    autoFileIncoming: true,
    autoFileSince: "2026-08-12T17:00:00.000Z"
  }}};
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const suppressions = {
    one: {accountId: "work", inboxFingerprint: fingerprint, state: "review", createdAt: old, absentSince: old},
    two: {accountId: "work", inboxFingerprint: fingerprint, state: "review", createdAt: old, absentSince: old}
  };
  const reconciler = createInboxReconciler({
    api: {messages: {list: () => ({id: null, messages: [current]})}},
    loadState: async () => ({accounts, config}),
    loadSuppressions: async () => suppressions,
    mutateSuppressions: inMemoryMutation(suppressions),
    mutateBaselines: inMemoryMutation({work: baseline()}),
    automaticFiler: {handleNewMail: async () => ({status: "complete"})}
  });

  await reconciler.reconcileAll();

  assert.equal(Object.keys(suppressions).length, 1);
});
