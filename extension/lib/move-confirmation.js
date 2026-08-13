// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {iterateMessageList, messageFolderId} from "./mail.js";

async function collectEventMessages(messageList, api) {
  const messages = [];
  for await (const message of iterateMessageList(messageList, api)) {
    messages.push(message);
  }
  return messages;
}

export function createMoveConfirmationBroker(api = messenger) {
  const pending = new Map();

  function indeterminateError(message) {
    const error = new Error(message);
    error.automaticMoveIndeterminate = true;
    return error;
  }

  function pendingKey(messageId, sourceFolderId) {
    return `${sourceFolderId}:${messageId}`;
  }

  function finish(key, outcome) {
    const entry = pending.get(key);
    if (!entry || entry.outcome) return;
    entry.outcome = outcome;
  }

  function correlateFirstPage(kind, originalList, resultingList) {
    for (const original of originalList?.messages ?? []) {
      const key = pendingKey(original.id, messageFolderId(original));
      const entry = pending.get(key);
      if (!entry || entry.outcome) continue;
      const reachedDestination = (resultingList?.messages ?? []).some(
        result => messageFolderId(result) === entry.destinationFolderId
      );
      finish(key, kind === "copied"
        ? {status: "copied", reachedDestination}
        : {status: reachedDestination ? "moved" : "wrong-destination"});
    }
  }

  async function observe(kind, originalList, resultingList) {
    correlateFirstPage(kind, originalList, resultingList);
    const originals = await collectEventMessages(originalList, api);
    const relevantOriginals = originals.filter(original =>
      pending.has(pendingKey(original.id, messageFolderId(original)))
    );
    // Event MessageLists are independent resources. Always consume the result
    // list even when this move belongs to Thunderbird or another extension.
    const results = await collectEventMessages(resultingList, api);
    for (const original of relevantOriginals) {
      const key = pendingKey(original.id, messageFolderId(original));
      const entry = pending.get(key);
      if (!entry || messageFolderId(original) !== entry.sourceFolderId) continue;
      const reachedDestination = results.some(
        result => messageFolderId(result) === entry.destinationFolderId
      );
      if (kind === "copied") {
        finish(key, {
          status: "copied",
          reachedDestination
        });
      } else {
        finish(key, {
          status: reachedDestination ? "moved" : "wrong-destination"
        });
      }
    }
  }

  // Register these listeners when the background module starts. That avoids a
  // race where Thunderbird emits the move event before an item-specific
  // listener can be installed.
  api.messages.onMoved.addListener((originals, moved) => {
    // Thunderbird dispatches async listeners without waiting for them. Capture
    // the first MessageList page synchronously before pagination can yield.
    correlateFirstPage("moved", originals, moved);
    return observe("moved", originals, moved).catch(error =>
      console.error("Could not correlate a Thunderbird move event", error)
    );
  });
  api.messages.onCopied.addListener((originals, copied) => {
    correlateFirstPage("copied", originals, copied);
    return observe("copied", originals, copied).catch(error =>
      console.error("Could not correlate a Thunderbird copy event", error)
    );
  });

  async function confirmMove(
    {messageId, sourceFolderId, destinationFolderId},
    operation
  ) {
    const key = pendingKey(messageId, sourceFolderId);
    if (pending.has(key)) {
      throw new Error("A move for this message is already awaiting confirmation");
    }

    pending.set(key, {
      sourceFolderId,
      destinationFolderId,
      outcome: null
    });

    try {
      await operation();
    } catch (error) {
      pending.delete(key);
      throw indeterminateError(
        `Thunderbird reported a move error, but the server outcome is uncertain: ${error.message}`
      );
    }

    // The move event is an accelerator, not a timed authority. Thunderbird
    // specifies no maximum IMAP operation/event latency, so a wall-clock
    // timeout can turn a slow valid move into a false failure. If no matching
    // event was observed by the time the API call resolves, leave the durable
    // attempt for Inbox reconciliation/manual review instead of waiting or
    // retrying blindly.
    const outcome = pending.get(key)?.outcome ?? {status: "accepted"};
    pending.delete(key);
    if (["moved", "accepted"].includes(outcome.status)) {
      return outcome;
    }
    if (outcome.status === "copied") {
      throw indeterminateError(
        outcome.reachedDestination
          ? "Thunderbird copied the message but left the original in Inbox"
          : "Thunderbird reported a copy instead of the requested move"
      );
    }
    if (outcome.status === "wrong-destination") {
      throw indeterminateError("Thunderbird moved the message to an unexpected folder");
    }
    throw indeterminateError("Thunderbird did not confirm the requested move");
  }

  return {confirmMove};
}
