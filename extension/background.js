// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  CONFIG_KEY,
  CURRENT_PLAN_KEY,
  CURRENT_BULK_SESSION_KEY,
  LAST_RUN_KEY,
  AUTO_SUPPRESSIONS_KEY,
  AUTO_BASELINES_KEY,
  CONTACT_BOOKS_KEY,
  PLAN_KEY_PREFIX,
  BULK_SESSION_KEY_PREFIX
} from "./lib/constants.js";
import {
  customerHasUnsafeDomain,
  normalizeConfig,
  validateConfig
} from "./lib/config.js";
import {createAutomaticFiler} from "./lib/automatic.js";
import {
  captureMovedMessageContacts,
  setupManagedContactBook,
  validateManagedContactBook
} from "./lib/contact-book.js";
import {
  importExistingCustomerContacts,
  scanExistingCustomerContacts
} from "./lib/contact-backfill.js";
import {normalizeManagedContactBooks} from "./lib/contact-state.js";
import {messageFingerprint} from "./lib/fingerprint.js";
import {proposeCustomersFromFolders} from "./lib/folder-import.js";
import {
  discoverExistingCustomerFolders,
  findSpecialFolder,
  getAccount,
  listAccounts,
  setupAllCustomerFolders
} from "./lib/folders.js";
import {iterateMessageList} from "./lib/mail.js";
import {createMoveConfirmationBroker} from "./lib/move-confirmation.js";
import {createInboxReconciler, RECONCILIATION_ALARM} from "./lib/reconciliation.js";
import {
  applyPlan,
  buildAddressReport,
  buildArchivePlan,
  buildOrganizePlan
} from "./lib/plans.js";
import {
  createBulkReviewSession,
  migrateBulkReviewSession,
  mergeBulkBatch,
  publicBulkProgress,
  validateBulkReviewSession
} from "./lib/bulk-review.js";
import {storeBulkPlanAndSession} from "./lib/transient-storage.js";

const accountQueues = new Map();
let mutationQueue = Promise.resolve();
let suppressionQueue = Promise.resolve();
let baselineQueue = Promise.resolve();
let stateMigrationQueue = Promise.resolve();
let bulkReviewQueue = Promise.resolve();
let contactQueue = Promise.resolve();
let contactBackfillQueue = Promise.resolve();
const AUTOMATIC_BASELINE_SCHEMA = 3;

function incrementCount(counts, key, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function validBaselineRecord(value) {
  return Boolean(
    value &&
    value.schemaVersion === 3 &&
    value.counts &&
    typeof value.counts === "object" &&
    value.hints &&
    typeof value.hints === "object"
  );
}

function automaticActivationRecord(value) {
  return Boolean(
    value &&
    value.schemaVersion === AUTOMATIC_BASELINE_SCHEMA &&
    value.initializing === true
  );
}

async function captureInboxBaseline(account, activatedAt = new Date().toISOString()) {
  const inbox = findSpecialFolder(account, "inbox");
  if (!inbox) {
    throw new Error(`No Inbox was found for “${account.name}”.`);
  }
  const counts = {};
  for await (const header of iterateMessageList(messenger.messages.list(inbox.id))) {
    incrementCount(counts, messageFingerprint(header));
  }
  return {schemaVersion: 3, activatedAt, counts, hints: {}, reviews: {}};
}

async function mutateAutomaticBaselines(mutator) {
  const queued = baselineQueue.catch(() => {}).then(async () => {
    const stored = await messenger.storage.local.get([
      AUTO_BASELINES_KEY,
      CONFIG_KEY
    ]);
    const baselines = structuredClone(stored[AUTO_BASELINES_KEY] ?? {});
    const outcome = await mutator(baselines, stored[CONFIG_KEY]);
    if (outcome?.write === false) {
      return outcome?.result;
    }
    await messenger.storage.local.set({
      [AUTO_BASELINES_KEY]: baselines,
      ...(outcome?.storage ?? {})
    });
    return outcome?.result;
  });
  baselineQueue = queued;
  return queued;
}

function configSnapshotToken(config) {
  return JSON.stringify(config);
}

/**
 * Commit a repair derived by loadState only if its configuration snapshot is
 * still current. The same queue also owns saveConfig's config+baseline commit,
 * so the comparison and write cannot be interleaved by a newer settings save.
 */
async function commitLoadStateRepair(expectedStoredConfig, expectedConfig, repair) {
  const expectedToken = configSnapshotToken(expectedStoredConfig);
  return mutateAutomaticBaselines((baselines, storedConfig) => {
    if (configSnapshotToken(storedConfig) !== expectedToken) {
      return {result: {committed: false}};
    }
    const nextConfig = structuredClone(expectedConfig);
    const value = repair(nextConfig, baselines);
    return {
      storage: {[CONFIG_KEY]: nextConfig},
      result: {
        committed: true,
        config: nextConfig,
        baselines: structuredClone(baselines),
        value
      }
    };
  });
}

async function recordAutomaticArrivalHints(accountId, messages) {
  return mutateAutomaticBaselines((baselines, storedConfig) => {
    let record = baselines[accountId];
    // Re-check eligibility inside the baseline queue. An event may be captured
    // before a settings save disables automation, then wait behind that save.
    // An initializing activation remains eligible so arrivals observed during
    // its Inbox census are retained until the activation commit.
    if (
      !storedConfig?.accounts?.[accountId]?.autoFileIncoming &&
      !automaticActivationRecord(record)
    ) {
      return {write: false};
    }
    if (automaticActivationRecord(record)) {
      record.pendingHints ??= {};
      for (const message of messages) {
        incrementCount(record.pendingHints, messageFingerprint(message));
      }
      return;
    }
    if (!validBaselineRecord(record)) {
      record = baselines[accountId] = {
        schemaVersion: 0,
        pendingHints: {...(record?.pendingHints ?? {})}
      };
      for (const message of messages) {
        incrementCount(record.pendingHints, messageFingerprint(message));
      }
      return;
    }
    for (const message of messages) {
      incrementCount(record.hints, messageFingerprint(message));
    }
  });
}

async function markAutomaticMessagesKnown(accountId, messages) {
  return mutateAutomaticBaselines(baselines => {
    const record = baselines[accountId];
    if (!validBaselineRecord(record)) return;
    for (const message of messages) {
      const fingerprint = messageFingerprint(message);
      incrementCount(record.counts, fingerprint);
      if (record.hints[fingerprint] > 1) record.hints[fingerprint] -= 1;
      else delete record.hints[fingerprint];
    }
  });
}

async function consumeAutomaticArrivalHint(accountId, message) {
  return mutateAutomaticBaselines(baselines => {
    const record = baselines[accountId];
    if (!validBaselineRecord(record)) return;
    const fingerprint = messageFingerprint(message);
    if (record.hints[fingerprint] > 1) record.hints[fingerprint] -= 1;
    else delete record.hints[fingerprint];
  });
}

function planStorageKey(planId) {
  return `${PLAN_KEY_PREFIX}${planId}`;
}

function bulkSessionStorageKey(sessionId) {
  return `${BULK_SESSION_KEY_PREFIX}${sessionId}`;
}

function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    identities: (account.identities ?? []).map(identity => ({
      id: identity.id,
      email: identity.email,
      name: identity.name
    }))
  };
}

async function loadState(conflictRetries = 0) {
  const accounts = await listAccounts();
  const stored = await messenger.storage.local.get([
    CONFIG_KEY,
    LAST_RUN_KEY,
    AUTO_BASELINES_KEY,
    AUTO_SUPPRESSIONS_KEY,
    CONTACT_BOOKS_KEY
  ]);
  let config = normalizeConfig(stored[CONFIG_KEY], accounts);
  let configStorageSnapshot = stored[CONFIG_KEY];
  const managedContactBooks = normalizeManagedContactBooks(stored[CONTACT_BOOKS_KEY]);
  const managedContactBookErrors = {};
  for (const account of accounts) {
    if (!config.accounts?.[account.id]?.enabled) continue;
    try {
      await validateManagedContactBook(
        account,
        managedContactBooks[account.id],
        messenger
      );
    } catch (error) {
      managedContactBookErrors[account.id] = error.message;
    }
  }
  let lastRun = stored[LAST_RUN_KEY] ?? null;
  let storedBaselines = stored[AUTO_BASELINES_KEY] ?? {};
  const unreadyAutomaticAccounts = Object.entries(config.accounts).filter(
    ([accountId, accountConfig]) =>
      accountConfig.autoFileIncoming &&
      (!accountConfig.customerRootReady || managedContactBookErrors[accountId])
  );
  if (unreadyAutomaticAccounts.length) {
    const repair = await commitLoadStateRepair(
      configStorageSnapshot,
      config,
      (nextConfig, baselines) => {
        for (const [accountId] of unreadyAutomaticAccounts) {
          nextConfig.accounts[accountId].autoFileIncoming = false;
          nextConfig.accounts[accountId].autoFileSince = null;
          delete baselines[accountId];
        }
        nextConfig.revision = nextConfig.revision >= Number.MAX_SAFE_INTEGER
          ? 0
          : nextConfig.revision + 1;
      }
    );
    if (!repair.committed) {
      if (conflictRetries >= 2) {
        throw new Error("Settings kept changing while safety checks were running. Try again.");
      }
      return loadState(conflictRetries + 1);
    }
    config = repair.config;
    configStorageSnapshot = repair.config;
    storedBaselines = repair.baselines;
    lastRun = {
      kind: "safety",
      title: "Automatic filing paused",
      finishedAt: new Date().toISOString(),
      attempted: 0,
      completed: 0,
      failed: 0,
      error: `Choose Save & set up before enabling automatic filing and contact capture for ${unreadyAutomaticAccounts.map(([accountId]) => accounts.find(account => account.id === accountId)?.name ?? accountId).join(", ")}`
    };
    await saveLastRun(lastRun);
  }
  const unsafeDomainRules = config.customers.filter(customer =>
    customer.enabled && customerHasUnsafeDomain(customer)
  );
  if (unsafeDomainRules.length) {
    const repair = await commitLoadStateRepair(
      configStorageSnapshot,
      config,
      (nextConfig, baselines) => {
        for (const accountConfig of Object.values(nextConfig.accounts)) {
          accountConfig.autoFileIncoming = false;
          accountConfig.autoFileSince = null;
        }
        nextConfig.revision = nextConfig.revision >= Number.MAX_SAFE_INTEGER
          ? 0
          : nextConfig.revision + 1;
        for (const accountId of Object.keys(baselines)) {
          delete baselines[accountId];
        }
      }
    );
    if (!repair.committed) {
      if (conflictRetries >= 2) {
        throw new Error("Settings kept changing while safety checks were running. Try again.");
      }
      return loadState(conflictRetries + 1);
    }
    config = repair.config;
    configStorageSnapshot = repair.config;
    storedBaselines = repair.baselines;
    lastRun = {
      kind: "safety",
      title: "Automatic filing paused",
      finishedAt: new Date().toISOString(),
      attempted: 0,
      completed: 0,
      failed: 0,
      error: `Remove broad public-suffix rules from: ${unsafeDomainRules.map(customer => customer.name).join(", ")}`
    };
    await saveLastRun(lastRun);
  }
  const migrationAccounts = [];
  for (const [accountId, accountConfig] of Object.entries(config.accounts)) {
    if (
      accountConfig.autoFileIncoming &&
      (!accountConfig.autoFileSince || !validBaselineRecord(storedBaselines[accountId]))
    ) {
      const account = accounts.find(candidate => candidate.id === accountId);
      if (account) migrationAccounts.push({account, accountConfig});
    }
  }
  if (migrationAccounts.length) {
    const migrate = stateMigrationQueue.catch(() => {}).then(async () => {
      let migrationConfig = config;
      let migrationStorageSnapshot = configStorageSnapshot;
      let migrationBaselines = storedBaselines;
      for (const {account} of migrationAccounts) {
        const activatedAt = new Date().toISOString();
        const claim = await commitLoadStateRepair(
          migrationStorageSnapshot,
          migrationConfig,
          (nextConfig, baselines) => {
            if (validBaselineRecord(baselines[account.id])) {
              nextConfig.accounts[account.id].autoFileSince =
                baselines[account.id].activatedAt ?? activatedAt;
              return {claimed: false};
            }
            baselines[account.id] = {
              schemaVersion: AUTOMATIC_BASELINE_SCHEMA,
              initializing: true,
              activatedAt,
              pendingHints: {...(baselines[account.id]?.pendingHints ?? {})}
            };
            return {claimed: true};
          }
        );
        if (!claim.committed) {
          return {conflict: true};
        }
        migrationConfig = claim.config;
        migrationStorageSnapshot = claim.config;
        migrationBaselines = claim.baselines;
        if (!claim.value.claimed) {
          continue;
        }
        const replacement = await captureInboxBaseline(account, activatedAt);
        const finalized = await commitLoadStateRepair(
          migrationStorageSnapshot,
          migrationConfig,
          (nextConfig, baselines) => {
            // Another queued migration may already have completed safely.
            if (validBaselineRecord(baselines[account.id])) {
              nextConfig.accounts[account.id].autoFileSince =
                baselines[account.id].activatedAt ?? activatedAt;
              return;
            }
            const pendingHints = baselines[account.id]?.pendingHints ?? {};
            for (const [fingerprint, count] of Object.entries(pendingHints)) {
              const captured = replacement.counts[fingerprint] ?? 0;
              const hinted = Math.min(count, captured);
              if (captured > hinted) replacement.counts[fingerprint] = captured - hinted;
              else delete replacement.counts[fingerprint];
              replacement.hints[fingerprint] = count;
            }
            baselines[account.id] = replacement;
            nextConfig.accounts[account.id].autoFileSince = activatedAt;
          }
        );
        if (!finalized.committed) {
          return {conflict: true};
        }
        migrationConfig = finalized.config;
        migrationStorageSnapshot = finalized.config;
        migrationBaselines = finalized.baselines;
      }
      return {
        conflict: false,
        config: migrationConfig,
        baselines: migrationBaselines
      };
    });
    stateMigrationQueue = migrate;
    const migration = await migrate;
    if (migration.conflict) {
      if (conflictRetries >= 2) {
        throw new Error("Settings kept changing while automatic filing was initialized. Try again.");
      }
      return loadState(conflictRetries + 1);
    }
    config = migration.config;
    storedBaselines = migration.baselines;
  }
  const automaticReviews = Object.values(stored[AUTO_SUPPRESSIONS_KEY] ?? {})
    .filter(entry => ["attempting", "review"].includes(entry?.state))
    .map(entry => ({
      accountId: entry.accountId,
      author: entry.author ?? "",
      subject: entry.subject ?? "",
      reason: entry.reason ?? "Automatic move outcome is uncertain",
      createdAt: entry.createdAt ?? null
    }));
  for (const [accountId, baseline] of Object.entries(storedBaselines)) {
    for (const review of Object.values(baseline?.reviews ?? {})) {
      automaticReviews.push({accountId, ...review, count: review.count ?? 1});
    }
  }
  return {
    accounts,
    config,
    lastRun,
    automaticReviews,
    managedContactBooks,
    managedContactBookErrors
  };
}

async function automaticConfigForCurrentState() {
  const accounts = await listAccounts();
  const stored = await messenger.storage.local.get([CONFIG_KEY, CONTACT_BOOKS_KEY]);
  const config = normalizeConfig(stored[CONFIG_KEY], accounts);
  const managedContactBooks = normalizeManagedContactBooks(stored[CONTACT_BOOKS_KEY]);
  const hasUnsafeRule = config.customers.some(customer =>
    customer.enabled && customerHasUnsafeDomain(customer)
  );
  for (const account of accounts) {
    const accountConfig = config.accounts[account.id];
    if (!accountConfig) continue;
    let contactBookReady = true;
    if (accountConfig.enabled && accountConfig.autoFileIncoming) {
      try {
        await validateManagedContactBook(
          account,
          managedContactBooks[account.id],
          messenger
        );
      } catch {
        contactBookReady = false;
      }
    }
    if (!accountConfig.customerRootReady || hasUnsafeRule || !contactBookReady) {
      accountConfig.autoFileIncoming = false;
      accountConfig.autoFileSince = null;
    }
  }
  return config;
}

async function storePlan(plan) {
  const previous = await messenger.storage.session.get(CURRENT_PLAN_KEY);
  const previousId = previous[CURRENT_PLAN_KEY];
  try {
    await messenger.storage.session.set({
      [CURRENT_PLAN_KEY]: plan.id,
      [planStorageKey(plan.id)]: plan
    });
  } catch (error) {
    const guidance = plan.kind === "addresses"
      ? "Open a more specific direct customer folder and try again"
      : "Lower “Maximum messages per preview” in Settings and try again";
    throw new Error(
      `The preview was too large for Thunderbird's temporary storage. ${guidance}. (${error.message})`
    );
  }
  if (previousId && previousId !== plan.id) {
    await messenger.storage.session.remove(planStorageKey(previousId));
  }
  return plan;
}

async function getPlan(planId) {
  const key = planStorageKey(planId);
  const stored = await messenger.storage.session.get(key);
  const plan = stored[key];
  if (!plan) {
    throw new Error("This preview expired. Start the action again.");
  }
  return plan;
}

async function saveLastRun(lastRun) {
  await messenger.storage.local.set({[LAST_RUN_KEY]: lastRun});
}

async function loadAutomaticSuppressions() {
  const stored = await messenger.storage.local.get(AUTO_SUPPRESSIONS_KEY);
  return stored[AUTO_SUPPRESSIONS_KEY] ?? {};
}

async function mutateAutomaticSuppressions(mutator) {
  const queued = suppressionQueue.catch(() => {}).then(async () => {
    const stored = await messenger.storage.local.get(AUTO_SUPPRESSIONS_KEY);
    const suppressions = structuredClone(stored[AUTO_SUPPRESSIONS_KEY] ?? {});
    const result = await mutator(suppressions);
    await messenger.storage.local.set({[AUTO_SUPPRESSIONS_KEY]: suppressions});
    return result;
  });
  suppressionQueue = queued;
  return queued;
}

async function saveBackgroundFailure(title, accountName, error) {
  await saveLastRun({
    kind: "error",
    title,
    finishedAt: new Date().toISOString(),
    accountName,
    attempted: 0,
    completed: 0,
    failed: 1,
    error: error.message
  });
}

function enqueueMutation(operation) {
  // Capture only jobs that were already queued. Later account jobs will wait
  // for this mutation, which avoids a circular wait while preserving ordering.
  const activeAccountJobs = [...accountQueues.values()];
  const queued = mutationQueue
    .catch(() => {})
    .then(() => Promise.allSettled(activeAccountJobs))
    .then(operation);
  mutationQueue = queued;
  return queued;
}

async function enqueueAccountJob(accountId, operation) {
  const previous = accountQueues.get(accountId) ?? Promise.resolve();
  const configurationBarrier = mutationQueue;
  const queued = Promise.allSettled([previous, configurationBarrier]).then(operation);
  accountQueues.set(accountId, queued);
  try {
    return await queued;
  } finally {
    if (accountQueues.get(accountId) === queued) {
      accountQueues.delete(accountId);
    }
  }
}

async function notifyProgress(progress) {
  try {
    await messenger.runtime.sendMessage({dmo: true, event: "progress", ...progress});
  } catch {
    // The organizer tab may have been closed. The job should still complete.
  }
}

async function createPlan(request) {
  const {config} = await loadState();
  let plan;
  if (request.kind === "organize") {
    plan = await buildOrganizePlan(request, config);
  } else if (request.kind === "archive") {
    plan = await buildArchivePlan(request, config);
  } else if (request.kind === "addresses") {
    plan = await buildAddressReport(request, config);
  } else {
    throw new Error(`Unknown preview type: ${request.kind}`);
  }
  return storePlan(plan);
}

async function loadBulkSession(sessionId) {
  if (!sessionId) {
    throw new Error("This entire-Inbox run expired. Start a new run from Settings.");
  }
  const key = bulkSessionStorageKey(sessionId);
  const stored = await messenger.storage.session.get(key);
  let migration;
  try {
    migration = migrateBulkReviewSession(stored[key]);
  } catch (error) {
    throw new Error(`${error.message} Start a new entire-Inbox run from Settings.`);
  }
  const session = migration.session;
  const errors = validateBulkReviewSession(session);
  if (errors.length) {
    throw new Error(`${errors.join("; ")} Start a new entire-Inbox run from Settings.`);
  }
  return migration;
}

async function buildBulkBatch(session) {
  const {config} = await loadState();
  if (config.revision !== session.configRevision) {
    throw new Error("Settings changed during this entire-Inbox run.");
  }
  if (session.exhausted) {
    throw new Error("This entire-Inbox run is already complete.");
  }
  const plan = await buildOrganizePlan({
    ...session.request,
    bulk: {
      sessionId: session.id,
      batchNumber: session.totals.batches + 1,
      examinedMessageIds: session.recordedMessageIds
    }
  }, config);
  const nextSession = mergeBulkBatch(session, plan);
  delete plan.bulkExaminedMessageIds;
  plan.bulk = publicBulkProgress(nextSession, plan);
  plan.title = `Process entire Inbox — batch ${nextSession.totals.batches}`;
  plan.description = `${plan.accountName} · all dates · safe review batches`;
  return storeBulkPlanAndSession(plan, nextSession, messenger.storage.session);
}

async function createFirstBulkPlan(accountId) {
  const {config} = await loadState();
  const session = createBulkReviewSession({
    id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${Math.random()}`,
    accountId,
    configRevision: config.revision,
    request: {kind: "organize", source: "inbox", accountId, days: 0}
  });
  return buildBulkBatch(session);
}

async function createNextBulkPlan(planId) {
  const plan = await getPlan(planId);
  if (!plan.bulk?.sessionId) {
    throw new Error("This preview is not part of an entire-Inbox run.");
  }
  const {session, migrated} = await loadBulkSession(plan.bulk.sessionId);
  if (!migrated && session.totals.batches !== plan.bulk.batchNumber) {
    throw new Error("A newer batch already exists for this entire-Inbox run.");
  }
  return buildBulkBatch(session);
}

function enqueueBulkReview(operation) {
  const queued = bulkReviewQueue.catch(() => {}).then(operation);
  bulkReviewQueue = queued;
  return queued;
}

function enqueueContactMutation(operation) {
  const queued = contactQueue.catch(() => {}).then(operation);
  contactQueue = queued;
  return queued;
}

function enqueueContactBackfill(operation) {
  const queued = contactBackfillQueue.catch(() => {}).then(operation);
  contactBackfillQueue = queued;
  return queued;
}

async function notifyContactBackfillProgress(progress) {
  try {
    await messenger.runtime.sendMessage({
      dmo: true,
      event: "contactBackfillProgress",
      ...progress
    });
  } catch {
    // The Settings page may have been closed. The user-requested scan should
    // continue, and a later run remains safe because imports are deduplicated.
  }
}

function emptyContactBackfillResult(account) {
  return {
    accountId: account.id,
    accountName: account.name,
    customersScanned: 0,
    foldersTotal: 0,
    foldersScanned: 0,
    messagesScanned: 0,
    attempted: 0,
    created: 0,
    existing: 0,
    failed: 0,
    skippedFolders: [],
    errors: []
  };
}

function contactBackfillTotals(accounts) {
  const totals = {
    accountsProcessed: accounts.length,
    foldersScanned: 0,
    messagesScanned: 0,
    attempted: 0,
    created: 0,
    existing: 0,
    failed: 0,
    skippedFolders: 0
  };
  for (const account of accounts) {
    totals.foldersScanned += account.foldersScanned ?? 0;
    totals.messagesScanned += account.messagesScanned ?? 0;
    totals.attempted += account.attempted ?? 0;
    totals.created += account.created ?? 0;
    totals.existing += account.existing ?? 0;
    totals.failed += account.failed ?? 0;
    totals.skippedFolders += account.skippedFolders?.length ?? 0;
  }
  return totals;
}

async function runContactBackfill() {
  const state = await loadState();
  const enabledAccounts = state.accounts.filter(
    account => state.config.accounts?.[account.id]?.enabled
  );
  if (!enabledAccounts.length) {
    throw new Error("Enable at least one mail account before building address books.");
  }

  const accounts = [];
  for (const account of enabledAccounts) {
    const result = emptyContactBackfillResult(account);
    const accountConfig = state.config.accounts[account.id];
    try {
      if (!accountConfig.customerRootReady) {
        throw new Error(
          "The domain root has not been set up. Choose Save & set up first."
        );
      }
      if (state.managedContactBookErrors?.[account.id]) {
        throw new Error(
          `${state.managedContactBookErrors[account.id]} Choose Save & set up first.`
        );
      }
      const storedBook = state.managedContactBooks?.[account.id];
      if (!storedBook?.addressBookId) {
        throw new Error(
          "The managed customer address book is not ready. Choose Save & set up first."
        );
      }

      const scan = await scanExistingCustomerContacts({
        account,
        config: state.config,
        api: messenger,
        onProgress: progress => notifyContactBackfillProgress({
          ...progress,
          phase: "scan",
          accountId: account.id,
          accountName: account.name
        })
      });
      Object.assign(result, {
        customersScanned: scan.customersScanned ?? scan.groups?.length ?? 0,
        foldersTotal: scan.foldersTotal ?? scan.customersTotal ?? 0,
        foldersScanned: scan.foldersScanned ?? 0,
        messagesScanned: scan.messagesScanned ?? 0,
        skippedFolders: scan.skippedFolders ?? [],
        errors: scan.errors ?? []
      });

      const imported = await enqueueContactMutation(() =>
        importExistingCustomerContacts({
          account,
          storedBook,
          groups: scan.groups ?? [],
          api: messenger,
          onProgress: progress => notifyContactBackfillProgress({
            ...progress,
            phase: "import",
            accountId: account.id,
            accountName: account.name,
            messagesScanned: result.messagesScanned,
            foldersScanned: result.foldersScanned,
            foldersTotal: result.foldersTotal
          })
        })
      );
      Object.assign(result, {
        attempted: imported.attempted ?? 0,
        created: imported.created ?? 0,
        existing: imported.existing ?? 0,
        failed: imported.failed ?? 0,
        errors: [
          ...result.errors,
          ...(imported.errors ?? [])
        ]
      });
    } catch (error) {
      result.errors.push(error.message);
    }
    accounts.push(result);
  }

  const totals = contactBackfillTotals(accounts);
  const result = {accounts, totals};
  await notifyContactBackfillProgress({phase: "complete", result, ...totals});
  return result;
}

async function captureAutomaticContacts({accountId, config, completed}) {
  return enqueueContactMutation(async () => {
    const account = await getAccount(accountId);
    const stored = await messenger.storage.local.get(CONTACT_BOOKS_KEY);
    const managedBook = normalizeManagedContactBooks(
      stored[CONTACT_BOOKS_KEY]
    )[accountId];
    return captureMovedMessageContacts({
      account,
      storedBook: managedBook,
      config,
      completed,
      api: messenger
    });
  });
}

async function openPlan(plan) {
  await messenger.tabs.create({
    active: true,
    url: messenger.runtime.getURL(`organizer/organizer.html?plan=${encodeURIComponent(plan.id)}`)
  });
}

async function saveConfigNow(rawConfig, {preserveVerifiedReadiness = false} = {}) {
  const accounts = await listAccounts();
  const stored = await messenger.storage.local.get([CONFIG_KEY, CONTACT_BOOKS_KEY]);
  const current = normalizeConfig(stored[CONFIG_KEY], accounts);
  const managedContactBooks = normalizeManagedContactBooks(stored[CONTACT_BOOKS_KEY]);
  const normalized = normalizeConfig(rawConfig, accounts);
  const baselineUpdates = {};
  const initializingAccounts = [];
  for (const [accountId, accountConfig] of Object.entries(normalized.accounts)) {
    const currentAccount = current.accounts[accountId];
    accountConfig.initialized = true;
    const requestedAutomatic = Boolean(
      accountConfig.enabled && accountConfig.autoFileRequested
    );
    accountConfig.customerRootReady = preserveVerifiedReadiness
      ? Boolean(accountConfig.customerRootReady)
      : Boolean(
          currentAccount?.customerRootReady &&
          currentAccount.rootFolderName === accountConfig.rootFolderName
        );
    accountConfig.archiveReady = preserveVerifiedReadiness
      ? Boolean(accountConfig.archiveReady)
      : Boolean(
          currentAccount?.archiveReady &&
          currentAccount.archiveFolderName === accountConfig.archiveFolderName
        );
    let automaticReady = Boolean(
      requestedAutomatic &&
      accountConfig.customerRootReady &&
      managedContactBooks[accountId]?.addressBookId
    );
    if (automaticReady) {
      const account = accounts.find(candidate => candidate.id === accountId);
      try {
        await validateManagedContactBook(
          account,
          managedContactBooks[accountId],
          messenger
        );
      } catch {
        automaticReady = false;
      }
    }
    // Keep the user's requested preference while setup is incomplete, but
    // never let the runtime flag become true until every ownership boundary
    // and managed contact destination has been validated.
    accountConfig.autoFileIncoming = automaticReady;
    const newlyEnabled = accountConfig.autoFileIncoming && !currentAccount?.autoFileIncoming;
    if (newlyEnabled) {
      const account = accounts.find(candidate => candidate.id === accountId);
      if (!account) {
        throw new Error(`Cannot enable automatic filing for unavailable account ${accountId}.`);
      }
      const activatedAt = new Date().toISOString();
      initializingAccounts.push({account, activatedAt});
      baselineUpdates[accountId] = null;
      // Automatic filing becomes effective only after the complete Inbox
      // baseline and configuration are committed together.
      accountConfig.autoFileSince = activatedAt;
    } else if (accountConfig.autoFileIncoming) {
      accountConfig.autoFileSince = currentAccount?.autoFileSince ?? new Date().toISOString();
    } else if (!accountConfig.autoFileIncoming) {
      accountConfig.autoFileSince = null;
      baselineUpdates[accountId] = null;
    }
  }
  const errors = validateConfig(normalized, accounts);
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  normalized.revision = current.revision >= Number.MAX_SAFE_INTEGER
    ? 0
    : current.revision + 1;
  if (initializingAccounts.length) {
    await mutateAutomaticBaselines(baselines => {
      for (const {account, activatedAt} of initializingAccounts) {
        baselines[account.id] = {
          schemaVersion: AUTOMATIC_BASELINE_SCHEMA,
          initializing: true,
          activatedAt,
          pendingHints: {...(baselines[account.id]?.pendingHints ?? {})}
        };
      }
    });
    for (const {account, activatedAt} of initializingAccounts) {
      const replacement = await captureInboxBaseline(account, activatedAt);
      baselineUpdates[account.id] = replacement;
    }
  }
  await mutateAutomaticBaselines(baselines => {
    for (const [accountId, update] of Object.entries(baselineUpdates)) {
      if (update) {
        const pendingHints = baselines[accountId]?.pendingHints ?? {};
        for (const [fingerprint, count] of Object.entries(pendingHints)) {
          const captured = update.counts[fingerprint] ?? 0;
          const hinted = Math.min(count, captured);
          if (captured > hinted) update.counts[fingerprint] = captured - hinted;
          else delete update.counts[fingerprint];
          update.hints[fingerprint] = count;
        }
        baselines[accountId] = update;
      }
      else delete baselines[accountId];
    }
    return {storage: {[CONFIG_KEY]: normalized}};
  });
  const currentPlan = await messenger.storage.session.get(CURRENT_PLAN_KEY);
  const currentPlanId = currentPlan[CURRENT_PLAN_KEY];
  if (currentPlanId) {
    await messenger.storage.session.remove([
      CURRENT_PLAN_KEY,
      planStorageKey(currentPlanId)
    ]);
  }
  const bulkSession = await messenger.storage.session.get(CURRENT_BULK_SESSION_KEY);
  const bulkSessionId = bulkSession[CURRENT_BULK_SESSION_KEY];
  if (bulkSessionId) {
    await messenger.storage.session.remove([
      CURRENT_BULK_SESSION_KEY,
      bulkSessionStorageKey(bulkSessionId)
    ]);
  }
  return normalized;
}

function saveConfig(rawConfig) {
  return enqueueMutation(() => saveConfigNow(rawConfig));
}

function handleMessage(message) {
  if (!message?.dmo || message.event) {
    return undefined;
  }
  return handleCommand(message);
}

async function handleCommand(message) {
  switch (message.command) {
    case "getBootstrap": {
      const state = await loadState();
      return {
        accounts: state.accounts.map(publicAccount),
        config: state.config,
        lastRun: state.lastRun,
        automaticReviews: state.automaticReviews,
        managedContactBooks: state.managedContactBooks,
        managedContactBookErrors: state.managedContactBookErrors
      };
    }
    case "saveConfig":
      return {config: await saveConfig(message.config)};
    case "prepareConfig": {
      const accounts = await listAccounts();
      const normalized = normalizeConfig(message.config, accounts);
      for (const accountConfig of Object.values(normalized.accounts)) {
        accountConfig.customerRootReady = false;
        accountConfig.archiveReady = false;
      }
      const errors = validateConfig(normalized, accounts);
      if (errors.length) {
        throw new Error(errors.join("\n"));
      }
      return {config: normalized};
    }
    case "setupFolders": {
      return enqueueMutation(async () => {
        const state = await loadState();
        const errors = validateConfig(state.config, state.accounts);
        if (errors.length) {
          throw new Error(errors.join("\n"));
        }
        const result = await setupAllCustomerFolders(
          state.config,
          state.accounts,
          messenger
        );
        const importedCustomers = [];
        for (const account of state.accounts) {
          const accountConfig = state.config.accounts?.[account.id];
          if (!accountConfig?.enabled || !accountConfig.customerRootReady) continue;
          try {
            const discovery = await discoverExistingCustomerFolders(
              account,
              accountConfig.rootFolderName,
              messenger
            );
            const proposals = proposeCustomersFromFolders(
              discovery.folders,
              account.id,
              state.config.customers
            );
            state.config.customers.push(...proposals);
            importedCustomers.push(...proposals.map(customer => ({
              accountId: account.id,
              accountName: account.name,
              customerName: customer.name,
              folderName: customer.folderName,
              enabled: customer.enabled,
              warning: customer.warning
            })));
          } catch (error) {
            result.errors.push(
              `${account.name} / ${accountConfig.rootFolderName}: could not import existing domain folders: ${error.message}`
            );
          }
        }
        const managedContactBooks = structuredClone(state.managedContactBooks ?? {});
        const contactBooks = [];
        for (const account of state.accounts) {
          const accountConfig = state.config.accounts?.[account.id];
          if (!accountConfig?.enabled || !accountConfig.customerRootReady) continue;
          try {
            const contactBook = await enqueueContactMutation(() =>
              setupManagedContactBook(
                account,
                managedContactBooks[account.id],
                messenger
              )
            );
            // Thunderbird exposes no atomic name claim. Re-list and validate
            // the chosen stable ID immediately before persisting/activating it
            // so a concurrent rename, deletion, or duplicate fails closed.
            const verifiedContactBook = await validateManagedContactBook(
              account,
              contactBook,
              messenger
            );
            managedContactBooks[account.id] = {
              addressBookId: verifiedContactBook.addressBookId,
              addressBookName: verifiedContactBook.addressBookName
            };
            // Persist the exact destination immediately after Thunderbird
            // creates, validates, or safely reuses the book. A later
            // folder/config storage failure must not lose that binding.
            await messenger.storage.local.set({
              [CONTACT_BOOKS_KEY]: managedContactBooks
            });
            contactBooks.push({
              ...verifiedContactBook,
              created: contactBook.created
            });
          } catch (error) {
            accountConfig.autoFileIncoming = false;
            accountConfig.autoFileSince = null;
            await mutateAutomaticBaselines(baselines => {
              delete baselines[account.id];
            });
            result.errors.push(`${account.name} / customer contacts: ${error.message}`);
          }
        }
        const savedConfig = await saveConfigNow(
          state.config,
          {preserveVerifiedReadiness: true}
        );
        result.contactBooks = contactBooks;
        result.importedCustomers = importedCustomers;
        return {result, config: savedConfig, managedContactBooks};
      });
    }
    case "backfillContacts":
      return enqueueContactBackfill(runContactBackfill);
    case "discoverExistingFolders": {
      const account = await getAccount(message.accountId);
      const discovery = await discoverExistingCustomerFolders(
        account,
        message.rootFolderName,
        messenger
      );
      return {
        ...discovery,
        proposedCustomers: proposeCustomersFromFolders(
          discovery.folders,
          account.id,
          (await loadState()).config.customers
        )
      };
    }
    case "createPlan":
      return createPlan(message.request);
    case "createAndOpenPlan": {
      const plan = await createPlan(message.request);
      await openPlan(plan);
      return {planId: plan.id};
    }
    case "createAndOpenBulkPlan": {
      return enqueueBulkReview(async () => {
        const plan = await createFirstBulkPlan(message.accountId);
        await openPlan(plan);
        return {planId: plan.id};
      });
    }
    case "createNextBulkPlan": {
      return enqueueBulkReview(async () => {
        const plan = await createNextBulkPlan(message.planId);
        return {planId: plan.id};
      });
    }
    case "getPlan":
      return getPlan(message.planId);
    case "applyPlan": {
      const plan = await getPlan(message.planId);
      return enqueueAccountJob(plan.accountId, async () => {
        const {config} = await loadState();
        const result = await applyPlan(
          plan,
          message.selectedItemIds ?? [],
          config,
          notifyProgress,
          messenger,
          {
            persistConfigState: updatedConfig =>
              messenger.storage.local.set({[CONFIG_KEY]: updatedConfig})
          }
        );
        const lastRun = {
          kind: plan.kind,
          title: plan.title,
          finishedAt: new Date().toISOString(),
          accountName: plan.accountName,
          ...result
        };
        await saveLastRun(lastRun);
        return result;
      });
    }
    case "openSettings":
      await messenger.runtime.openOptionsPage();
      return {opened: true};
    default:
      throw new Error(`Unknown Domain Mail Organizer command: ${message.command}`);
  }
}

messenger.runtime.onMessage.addListener(handleMessage);

messenger.runtime.onInstalled.addListener(() => {
  messenger.menus.create({
    id: "dmo-preview-selected",
    title: "Preview customer filing",
    contexts: ["message_list"]
  });
});

messenger.menus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "dmo-preview-selected" || !info.selectedMessages?.messages?.length) {
    return;
  }
  try {
    const first = info.selectedMessages.messages[0];
    const accountId = first.folder?.accountId;
    if (!accountId) {
      throw new Error("Could not determine the selected messages’ account.");
    }
    const plan = await createPlan({
      kind: "organize",
      accountId,
      days: 0,
      messageList: info.selectedMessages
    });
    await openPlan(plan);
  } catch (error) {
    console.error("Domain Mail Organizer context preview failed", error);
    await saveBackgroundFailure(
      "Selected-message preview failed",
      info.selectedMessages.messages[0]?.folder?.accountId ?? "Unknown account",
      error
    ).catch(storageError => console.error("Could not save preview failure", storageError));
  }
});

const moveConfirmation = createMoveConfirmationBroker(messenger);
const automaticFiler = createAutomaticFiler({
  api: messenger,
  // The event path needs a read-only, fail-closed snapshot and must not perform
  // setup migrations behind its own account queue.
  loadState: async () => ({config: await automaticConfigForCurrentState()}),
  saveLastRun,
  runExclusive: enqueueAccountJob,
  confirmMove: moveConfirmation.confirmMove,
  loadSuppressions: loadAutomaticSuppressions,
  mutateSuppressions: mutateAutomaticSuppressions,
  recordArrivalHints: recordAutomaticArrivalHints,
  markKnown: markAutomaticMessagesKnown,
  consumeArrivalHint: consumeAutomaticArrivalHint,
  captureContacts: captureAutomaticContacts,
  persistConfigState: updatedConfig =>
    messenger.storage.local.set({[CONFIG_KEY]: updatedConfig})
});
const inboxReconciler = createInboxReconciler({
  api: messenger,
  loadState,
  automaticFiler,
  loadSuppressions: loadAutomaticSuppressions,
  mutateSuppressions: mutateAutomaticSuppressions,
  mutateBaselines: mutateAutomaticBaselines,
  onFailure: (account, error) => saveBackgroundFailure(
    "Automatic Inbox reconciliation failed",
    account.name,
    error
  ),
  onReview: (account, messages) => saveLastRun({
    kind: "automatic-review",
    title: "Automatic Inbox review needed",
    finishedAt: new Date().toISOString(),
    accountName: account.name,
    attempted: 0,
    completed: 0,
    failed: 0,
    error: `${messages.length} old-dated Inbox message${messages.length === 1 ? "" : "s"} appeared without a new-mail event and were left in Inbox for safety`
  })
});

messenger.messages.onNewMailReceived.addListener((folder, messageList) => {
  return automaticFiler.handleNewMail(folder, messageList).catch(async error => {
    console.error("Domain Mail Organizer automatic filing failed", error);
    let accountName = folder.accountId;
    try {
      accountName = (await messenger.accounts.get(folder.accountId))?.name ?? accountName;
    } catch {
      // Retain the account id if the account disappeared during processing.
    }
    await saveBackgroundFailure(
      "Automatic Inbox filing failed",
      accountName,
      error
    ).catch(storageError => console.error("Could not save automatic failure", storageError));
  });
});

messenger.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== RECONCILIATION_ALARM) return undefined;
  return inboxReconciler.reconcileAll();
});
messenger.runtime.onStartup.addListener(() => inboxReconciler.reconcileAll());

// Thunderbird has an open reliability issue where an occasional arrival may
// not produce onNewMailReceived. A periodic Inbox reconciliation is the safety
// net; every candidate is still re-fetched and required to remain in Inbox.
messenger.alarms.get(RECONCILIATION_ALARM).then(existing => {
  if (!existing) {
    messenger.alarms.create(RECONCILIATION_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 5
    });
  }
}).catch(error => console.error("Could not schedule Inbox reconciliation", error));
