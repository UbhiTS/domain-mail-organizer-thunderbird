// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  BULK_SESSION_KEY_PREFIX,
  CURRENT_BULK_SESSION_KEY,
  CURRENT_PLAN_KEY,
  PLAN_KEY_PREFIX
} from "./constants.js";

function planStorageKey(planId) {
  return `${PLAN_KEY_PREFIX}${planId}`;
}

function bulkSessionStorageKey(sessionId) {
  return `${BULK_SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * Publish a bulk batch and its progress as one storage.session mutation.
 * Neither current pointer can observe a session that advanced without the
 * matching plan (or vice versa) if Thunderbird rejects the write.
 */
export async function storeBulkPlanAndSession(plan, session, storageArea) {
  const previous = await storageArea.get([
    CURRENT_PLAN_KEY,
    CURRENT_BULK_SESSION_KEY
  ]);
  const previousPlanId = previous[CURRENT_PLAN_KEY];
  const previousSessionId = previous[CURRENT_BULK_SESSION_KEY];

  try {
    await storageArea.set({
      [CURRENT_PLAN_KEY]: plan.id,
      [planStorageKey(plan.id)]: plan,
      [CURRENT_BULK_SESSION_KEY]: session.id,
      [bulkSessionStorageKey(session.id)]: session
    });
  } catch (error) {
    throw new Error(
      `The entire-Inbox batch was too large for Thunderbird's temporary storage. ` +
      `Lower “Maximum messages per preview” or process a narrower window first. (${error.message})`
    );
  }

  const obsoleteKeys = [];
  if (previousPlanId && previousPlanId !== plan.id) {
    obsoleteKeys.push(planStorageKey(previousPlanId));
  }
  if (previousSessionId && previousSessionId !== session.id) {
    obsoleteKeys.push(bulkSessionStorageKey(previousSessionId));
  }
  if (obsoleteKeys.length) {
    try {
      await storageArea.remove(obsoleteKeys);
    } catch {
      // The new plan and progress are already committed. Stale, unreferenced
      // values are preferable to reporting failure and encouraging a retry of
      // a batch that Thunderbird has successfully published.
    }
  }
  return plan;
}
