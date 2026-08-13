// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {folderHasSpecialUse} from "./folders.js";
import {accountMessageFingerprint, messageFingerprint} from "./fingerprint.js";
import {iterateMessageList} from "./mail.js";
import {applyPlan, buildOrganizePlan} from "./plans.js";

export async function materializeMessageList(messageList, api = messenger) {
  const messages = [];
  for await (const message of iterateMessageList(messageList, api)) {
    messages.push(message);
  }
  return {id: null, messages};
}

function describeFailures(results) {
  const counts = new Map();
  for (const result of results ?? []) {
    if (result.status !== "failed" || !result.error) continue;
    counts.set(result.error, (counts.get(result.error) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, 3)
    .map(([message, count]) => `${count} × ${message}`)
    .join("; ");
}

export function createAutomaticFiler({
  api = messenger,
  loadState,
  saveLastRun,
  runExclusive,
  confirmMove,
  loadSuppressions = async () => ({}),
  mutateSuppressions,
  recordArrivalHints = async () => {},
  markKnown = async () => {},
  consumeArrivalHint = async () => {},
  captureContacts = async () => ({attempted: 0, created: 0, existing: 0, failed: 0}),
  buildPlan = buildOrganizePlan,
  apply = applyPlan
}) {
  function handleNewMail(
    folder,
    messageList,
    {recordArrival = true, respectSuppressions = true} = {}
  ) {
    // Thunderbird owns continuation ids. Start consuming every event list now,
    // before this account waits behind another operation, and never persist the
    // resulting session-scoped message ids.
    const capturedList = materializeMessageList(messageList, api).then(async stableList => {
      if (
        recordArrival &&
        folderHasSpecialUse(folder, "inbox") &&
        stableList.messages.length
      ) {
        await recordArrivalHints(folder.accountId, stableList.messages);
      }
      return stableList;
    });
    // Attach a rejection observer immediately. The account queue may not await
    // this Promise until much later, and a continuation failure must not become
    // an unhandled rejection while it is waiting.
    capturedList.catch(() => {});
    if (!folderHasSpecialUse(folder, "inbox")) {
      return capturedList.then(() => ({status: "ignored"}));
    }

    return runExclusive(folder.accountId, async () => {
      const stableList = await capturedList;
      if (!stableList.messages.length) {
        return {status: "no-mail"};
      }

      // Read settings only when the queued job starts. A user can disable
      // automatic filing or change a rule while this event is waiting.
      const {config} = await loadState();
      const accountConfig = config.accounts?.[folder.accountId];
      if (!accountConfig?.enabled || !accountConfig.autoFileIncoming) {
        return {status: "disabled"};
      }

      const plan = await buildPlan(
        {
          kind: "organize",
          accountId: folder.accountId,
          days: 0,
          automatic: true,
          messageList: stableList
        },
        config,
        api
      );
      const suppressions = respectSuppressions ? await loadSuppressions() : {};
      const suppressionClaims = new Map();
      for (const [key, suppression] of Object.entries(suppressions)) {
        const fingerprint = suppression?.fingerprint ?? key;
        suppressionClaims.set(
          fingerprint,
          (suppressionClaims.get(fingerprint) ?? 0) + 1
        );
      }
      let suppressedCount = 0;
      plan.items = plan.items.map(item => {
        if (!item.action) return item;
        const key = accountMessageFingerprint(plan.accountId, item);
        const claimed = suppressionClaims.get(key) ?? 0;
        if (!claimed) return item;
        suppressionClaims.set(key, claimed - 1);
        suppressedCount += 1;
        return {
          ...item,
          action: null,
          status: "skipped",
          reason: "Previous automatic move outcome is indeterminate; review this message manually",
          suppressedByAttempt: true
        };
      });
      const knownItems = plan.items.filter(
        item => !item.action && !item.suppressedByAttempt
      );
      if (knownItems.length) {
        await markKnown(plan.accountId, knownItems);
      }
      const selected = plan.items.filter(item => item.action).map(item => item.id);
      if (!selected.length) {
        // Preserve useful diagnostics for ambiguous/protected arrivals without
        // replacing the prior run for ordinary unmatched newsletters.
        if (plan.summary?.ambiguous || plan.summary?.skipped || suppressedCount) {
          await saveLastRun({
            kind: "automatic",
            title: "Automatic Inbox filing",
            finishedAt: new Date().toISOString(),
            accountName: plan.accountName,
            attempted: 0,
            completed: 0,
            failed: 0,
            error: `${plan.summary.ambiguous ?? 0} ambiguous, ${plan.summary.skipped ?? 0} protected/skipped, and ${suppressedCount} awaiting manual review; no messages moved`
          });
        }
        return {status: "no-match", plan};
      }

      // Folder setup is the ownership boundary for the customer tree. Once the
      // root is approved, automatic filing may safely create a missing direct
      // child for a configured customer. It must never adopt an arbitrary root
      // that merely has the configured name.
      if (!accountConfig.customerRootReady) {
        const error = "Run Save & set up folders once before enabling automatic filing";
        await saveLastRun({
          kind: "automatic",
          title: "Automatic Inbox filing",
          finishedAt: new Date().toISOString(),
          accountName: plan.accountName,
          attempted: selected.length,
          completed: 0,
          failed: selected.length,
          error
        });
        return {
          status: "failed",
          plan,
          attempted: selected.length,
          completed: 0,
          failed: selected.length,
          error
        };
      }

      // Apply exactly once. A successful IMAP move can take time to appear in a
      // destination query, so a query-and-retry loop could duplicate mail.
      // Every item is re-fetched, reclassified, and required to remain in Inbox.
      const journaledConfirmMove = confirmMove && mutateSuppressions
        ? async (descriptor, operation) => {
            const item = descriptor.item;
            const fingerprint = accountMessageFingerprint(plan.accountId, item);
            const attemptId = globalThis.crypto?.randomUUID?.() ??
              `attempt-${Date.now()}-${Math.random()}`;
            await mutateSuppressions(state => {
              state[attemptId] = {
                accountId: plan.accountId,
                fingerprint,
                inboxFingerprint: messageFingerprint(item),
                state: "attempting",
                customerId: item.customerId,
                destinationName: item.destinationName,
                headerMessageId: item.headerMessageId,
                author: item.author,
                subject: item.subject,
                createdAt: new Date().toISOString()
              };
            });
            try {
              await consumeArrivalHint(plan.accountId, item);
              const outcome = await confirmMove(descriptor, operation);
              await mutateSuppressions(state => {
                if (!state[attemptId]) return;
                state[attemptId].state = "confirmed";
                state[attemptId].confirmedAt = new Date().toISOString();
              });
              return outcome;
            } catch (error) {
              await mutateSuppressions(state => {
                if (!state[attemptId]) return;
                state[attemptId].state = "review";
                state[attemptId].reason = error.message;
                state[attemptId].updatedAt = new Date().toISOString();
              });
              throw error;
            }
          }
        : confirmMove;
      const result = await apply(plan, selected, config, null, api, {
        createFolders: true,
        liveDestinations: true,
        isUserAction: false,
        allowBody: false,
        allowSubject: false,
        requireInboxSource: true,
        requireDefiniteMove: true,
        confirmMove: journaledConfirmMove
      });
      let contacts = {attempted: 0, created: 0, existing: 0, failed: 0};
      let contactError;
      if (result.completed) {
        const itemById = new Map(plan.items.map(item => [item.id, item]));
        const messageById = new Map(
          stableList.messages.map(message => [message.id, message])
        );
        const completed = (result.results ?? [])
          .filter(itemResult => itemResult.status === "completed")
          .map(itemResult => {
            const item = itemById.get(itemResult.itemId);
            const message = item ? messageById.get(item.messageId) : null;
            return item && message ? {item, message, result: itemResult} : null;
          })
          .filter(Boolean);
        try {
          if (completed.length) {
            contacts = {
              ...contacts,
              ...await captureContacts({
                accountId: plan.accountId,
                config,
                completed
              })
            };
          }
        } catch (error) {
          contacts.failed = completed.length;
          contactError = `Contact capture failed: ${error.message}`;
        }
      }
      if (!contactError && contacts.failed) {
        contactError = contacts.error ??
          `${contacts.failed} contact${contacts.failed === 1 ? "" : "s"} could not be added`;
      }
      const moveError = result.failed ? describeFailures(result.results) : undefined;
      const error = [moveError, contactError].filter(Boolean).join("; ") || undefined;
      const lastRun = {
        kind: "automatic",
        title: "Automatic Inbox filing",
        finishedAt: new Date().toISOString(),
        accountName: plan.accountName,
        attempted: result.attempted,
        completed: result.completed,
        failed: result.failed,
        contactsAttempted: contacts.attempted,
        contactsCreated: contacts.created,
        contactsExisting: contacts.existing,
        contactsFailed: contacts.failed,
        ...(error ? {error} : {})
      };
      await saveLastRun(lastRun);
      return {
        status: result.failed ? (result.completed ? "partial" : "failed") : "complete",
        plan,
        contacts,
        ...result
      };
    });
  }

  return {handleNewMail};
}
