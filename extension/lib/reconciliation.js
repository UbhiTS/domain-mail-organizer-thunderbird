// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {messageFingerprint} from "./fingerprint.js";
import {findSpecialFolder} from "./folders.js";
import {iterateMessageList} from "./mail.js";

export const RECONCILIATION_ALARM = "dmo-reconcile-inboxes";

function suppressionCountsForAccount(suppressions, accountId) {
  const counts = new Map();
  for (const suppression of Object.values(suppressions ?? {})) {
    if (suppression?.accountId !== accountId || !suppression.inboxFingerprint) continue;
    counts.set(
      suppression.inboxFingerprint,
      (counts.get(suppression.inboxFingerprint) ?? 0) + 1
    );
  }
  return counts;
}

function messageTime(message) {
  const value = message?.date instanceof Date ? message.date.getTime() : Date.parse(message?.date ?? "");
  return Number.isFinite(value) ? value : null;
}

export function selectReconciliationCandidates({
  baseline,
  messages,
  suppressions,
  accountId,
  activationTime,
  limit = 50
}) {
  const groups = new Map();
  baseline.reviews ??= {};
  for (const message of messages) {
    const fingerprint = messageFingerprint(message);
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(message);
  }

  const attempts = suppressionCountsForAccount(suppressions, accountId);
  const candidates = [];
  const oldDateReview = [];
  const allFingerprints = new Set([
    ...Object.keys(baseline.counts ?? {}),
    ...Object.keys(baseline.hints ?? {}),
    ...groups.keys()
  ]);

  for (const fingerprint of allFingerprints) {
    const current = groups.get(fingerprint) ?? [];
    if (!current.length) {
      delete baseline.counts[fingerprint];
      delete baseline.reviews[fingerprint];
      // Keep a durable arrival hint that may have been written after this scan
      // began. The direct event path consumes its hint when the message is
      // classified or journaled, so deleting it here would reopen a crash gap.
      continue;
    }
    const attemptCount = Math.min(attempts.get(fingerprint) ?? 0, current.length);
    const knownCapacity = Math.max(0, current.length - attemptCount);
    const knownCount = Math.min(baseline.counts[fingerprint] ?? 0, knownCapacity);
    if (knownCount) baseline.counts[fingerprint] = knownCount;
    else delete baseline.counts[fingerprint];
    if (baseline.reviews[fingerprint]) {
      const reviewCount = Math.min(
        baseline.reviews[fingerprint].count ?? 1,
        knownCount
      );
      if (reviewCount) baseline.reviews[fingerprint].count = reviewCount;
      else delete baseline.reviews[fingerprint];
    }

    const extras = current.slice(attemptCount + knownCount);
    let hintCount = Math.min(baseline.hints[fingerprint] ?? 0, extras.length);
    if (hintCount) baseline.hints[fingerprint] = hintCount;
    else delete baseline.hints[fingerprint];

    for (const message of extras) {
      const eventHinted = hintCount > 0;
      if (eventHinted) hintCount -= 1;
      const timestamp = messageTime(message);
      const safelyRecent = timestamp !== null && timestamp >= activationTime;
      if (eventHinted || safelyRecent) {
        if (candidates.length < limit) candidates.push(message);
        continue;
      }

      // Thunderbird 140 exposes neither IMAP INTERNALDATE nor a durable Inbox
      // sequence. A scan-only old-dated message could be a missed arrival or
      // historical mail synchronized after activation. Fail closed and make it
      // known/reviewable instead of silently bulk-filing history.
      baseline.counts[fingerprint] = (baseline.counts[fingerprint] ?? 0) + 1;
      const existingReview = baseline.reviews[fingerprint];
      baseline.reviews[fingerprint] = {
        author: message.author ?? "",
        subject: message.subject ?? "",
        reason: "Old-dated message appeared without a new-mail event and was left in Inbox",
        createdAt: existingReview?.createdAt ?? new Date().toISOString(),
        count: (existingReview?.count ?? 0) + 1
      };
      oldDateReview.push(message);
    }
  }

  return {candidates, oldDateReview};
}

export function createInboxReconciler({
  api = messenger,
  loadState,
  automaticFiler,
  loadSuppressions = async () => ({}),
  mutateSuppressions = async () => {},
  mutateBaselines,
  onFailure = async () => {},
  onReview = async () => {},
  candidateLimit = 50
}) {
  let inFlight = null;

  async function reconcileAccount(account, config) {
    const accountConfig = config.accounts?.[account.id];
    if (!accountConfig?.enabled || !accountConfig.autoFileIncoming) {
      return {accountId: account.id, status: "disabled"};
    }
    const inbox = findSpecialFolder(account, "inbox");
    if (!inbox) {
      return {accountId: account.id, status: "no-inbox"};
    }
    const activationTime = Date.parse(accountConfig.autoFileSince ?? "");
    if (!Number.isFinite(activationTime)) {
      return {accountId: account.id, status: "awaiting-activation-boundary"};
    }

    const scanStartedAt = Date.now();
    const messages = [];
    for await (const message of iterateMessageList(api.messages.list(inbox.id), api)) {
      messages.push(message);
    }
    const presentCounts = new Map();
    for (const message of messages) {
      const fingerprint = messageFingerprint(message);
      presentCounts.set(fingerprint, (presentCounts.get(fingerprint) ?? 0) + 1);
    }
    await mutateSuppressions(state => {
      const attemptsByFingerprint = new Map();
      for (const [attemptId, attempt] of Object.entries(state)) {
        if (attempt?.accountId !== account.id || !attempt.inboxFingerprint) continue;
        if (!attemptsByFingerprint.has(attempt.inboxFingerprint)) {
          attemptsByFingerprint.set(attempt.inboxFingerprint, []);
        }
        attemptsByFingerprint.get(attempt.inboxFingerprint).push([attemptId, attempt]);
      }
      for (const [fingerprint, attempts] of attemptsByFingerprint) {
        let remaining = presentCounts.get(fingerprint) ?? 0;
        attempts.sort((left, right) =>
          Date.parse(left[1].createdAt ?? "") - Date.parse(right[1].createdAt ?? "")
        );
        for (const [attemptId, attempt] of attempts) {
          const createdAt = Date.parse(attempt.createdAt ?? "");
          if (!Number.isFinite(createdAt) || createdAt >= scanStartedAt) continue;
          if (remaining > 0) {
            remaining -= 1;
            delete attempt.absentSince;
            if (attempt.state === "confirmed") {
              attempt.state = "review";
              attempt.reason = "A previously confirmed automatic move is still present in Inbox";
              attempt.updatedAt = new Date().toISOString();
            }
            continue;
          }
          if (!attempt.absentSince) {
            attempt.absentSince = new Date().toISOString();
            continue;
          }
          const absentSince = Date.parse(attempt.absentSince);
          if (Number.isFinite(absentSince) && Date.now() - absentSince >= 24 * 60 * 60 * 1000) {
            delete state[attemptId];
          }
        }
      }
    });
    const suppressions = await loadSuppressions();
    const selection = await mutateBaselines(baselines => {
      const baseline = baselines[account.id];
      if (!baseline || baseline.schemaVersion !== 3) {
        return {result: {status: "awaiting-baseline", candidates: [], oldDateReview: []}};
      }
      return {
        result: {
          status: "ready",
          ...selectReconciliationCandidates({
            baseline,
            messages,
            suppressions,
            accountId: account.id,
            activationTime,
            limit: candidateLimit
          })
        }
      };
    });
    if (selection.status !== "ready") {
      return {accountId: account.id, status: selection.status};
    }
    if (selection.oldDateReview.length) {
      await onReview(account, selection.oldDateReview);
    }
    if (!selection.candidates.length) {
      return {
        accountId: account.id,
        status: "complete",
        reviewed: selection.oldDateReview.length,
        candidates: 0
      };
    }

    const outcome = await automaticFiler.handleNewMail(
      inbox,
      {id: null, messages: selection.candidates},
      {recordArrival: false, respectSuppressions: false}
    );
    return {
      accountId: account.id,
      status: outcome.status,
      reviewed: selection.oldDateReview.length,
      candidates: selection.candidates.length,
      outcome
    };
  }

  async function runReconciliation() {
    const {accounts, config} = await loadState();
    const results = [];
    for (const account of accounts) {
      try {
        results.push(await reconcileAccount(account, config));
      } catch (error) {
        console.error(`Inbox reconciliation failed for ${account.name}`, error);
        await onFailure(account, error);
        results.push({accountId: account.id, status: "failed", error: error.message});
      }
    }
    return results;
  }

  function reconcileAll() {
    if (inFlight) return inFlight;
    inFlight = runReconciliation().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {reconcileAll};
}
