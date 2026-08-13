import test from "node:test";
import assert from "node:assert/strict";

import {
  createBulkReviewSession,
  createMessageIdSkipper,
  migrateBulkReviewSession,
  mergeBulkBatch,
  mergePlanScanDelta,
  publicBulkProgress,
  publicBulkReviewProgress,
  recordMessageIds,
  validateBulkReviewSession
} from "../extension/lib/bulk-review.js";

const CREATED_AT = "2026-08-12T20:00:00.000Z";

function message(id, overrides = {}) {
  return {
    id,
    headerMessageId: `<${id}@example.test>`,
    date: "2026-08-12T19:00:00.000Z",
    author: `Sender ${id} <sender${id}@example.test>`,
    recipients: ["Engineer <engineer@example.test>"],
    ccList: [],
    bccList: [],
    subject: `Message ${id}`,
    size: 100 + Number(id),
    ...overrides
  };
}

function session() {
  return createBulkReviewSession({
    id: "review-1",
    accountId: "work",
    configRevision: 7,
    request: {source: "inbox", kind: "organize", accountId: "work", days: 0},
    createdAt: CREATED_AT
  });
}

test("new bulk-review sessions are canonical, isolated, and empty", () => {
  const request = {
    source: "inbox",
    nested: {z: 2, a: 1},
    kind: "organize",
    accountId: "work"
  };
  const state = createBulkReviewSession({
    id: "review-1",
    accountId: "work",
    configRevision: 7,
    request,
    createdAt: CREATED_AT
  });
  request.nested.a = 99;

  assert.deepEqual(state.request, {
    accountId: "work",
    kind: "organize",
    nested: {a: 1, z: 2},
    source: "inbox"
  });
  assert.deepEqual(state.recordedMessageIds, []);
  assert.deepEqual(state.committedPlanIds, []);
  assert.equal(state.totals.batches, 0);
  assert.equal(state.exhausted, false);
  assert.deepEqual(validateBulkReviewSession(state), []);
});

test("message id recording is immutable and rejects duplicate ids", () => {
  const ids = recordMessageIds([], [message(1), message(2)]);

  assert.deepEqual(ids, [1, 2]);
  const extended = recordMessageIds(ids, [message(3)]);
  assert.deepEqual(ids, [1, 2]);
  assert.deepEqual(extended, [1, 2, 3]);
  assert.throws(() => recordMessageIds(ids, [{...message(1), headerMessageId: "different"}]), /repeats/u);
});

test("the id skipper ignores only exact session-scoped message ids", () => {
  const skipper = createMessageIdSkipper([1, 2]);

  assert.equal(skipper.shouldSkip(message(1)), true);
  assert.equal(skipper.shouldSkip({...message(1), headerMessageId: "different"}), true);
  assert.equal(skipper.shouldSkip({...message(1), id: 999}), false);
  assert.equal(skipper.shouldSkip(message(3)), false);
  assert.deepEqual(skipper.progress(), {
    skippedCount: 2,
    claimedMessageIds: [1],
    remainingMessageIds: [2]
  });
});

test("merging a plan delta records progress without retaining move authority", () => {
  const first = {...message(1), action: "move", destinationFolderId: "customer"};
  const second = {...message(2), action: null};
  const original = session();
  const merged = mergePlanScanDelta(original, {
    planId: "plan-1",
    messages: [first, second],
    examined: 7,
    skippedRecorded: 5,
    summary: {
      total: 2,
      actionable: 1,
      matched: 1,
      ambiguous: 0,
      unmatched: 1,
      skipped: 0
    },
    exhausted: false,
    committedAt: "2026-08-12T20:05:00.000Z"
  });

  assert.equal(original.totals.batches, 0);
  assert.equal(merged.totals.batches, 1);
  assert.equal(merged.totals.examined, 7);
  assert.equal(merged.totals.skippedRecorded, 5);
  assert.equal(merged.totals.presented, 2);
  assert.deepEqual(merged.recordedMessageIds, [1, 2]);
  assert.equal("messages" in merged, false);
  assert.equal("action" in merged, false);
  assert.equal("destinationFolderId" in merged, false);
  assert.deepEqual(publicBulkReviewProgress(merged), {
    sessionId: "review-1",
    accountId: "work",
    configRevision: 7,
    batches: 1,
    examined: 7,
    reviewed: 2,
    skippedPreviouslyReviewed: 5,
    presented: 2,
    actionable: 1,
    matched: 1,
    ambiguous: 0,
    unmatched: 1,
    skipped: 0,
    exhausted: false,
    updatedAt: "2026-08-12T20:05:00.000Z"
  });
});

test("plan delta commits are idempotent and exhaustion is terminal", () => {
  const delta = {
    planId: "plan-1",
    messages: [message(1)],
    examined: 1,
    summary: {total: 1, unmatched: 1},
    exhausted: true,
    committedAt: "2026-08-12T20:05:00.000Z"
  };
  const merged = mergePlanScanDelta(session(), delta);
  const replayed = mergePlanScanDelta(merged, delta);

  assert.deepEqual(replayed, merged);
  assert.throws(
    () => mergePlanScanDelta(merged, {
      ...delta,
      planId: "plan-2",
      committedAt: "2026-08-12T20:06:00.000Z"
    }),
    /exhausted/u
  );
});

test("validation rejects malformed or stale session ownership", () => {
  const state = session();
  assert.deepEqual(validateBulkReviewSession(state, {
    accountId: "work",
    configRevision: 7,
    request: {days: 0, accountId: "work", kind: "organize", source: "inbox"}
  }), []);

  const corrupt = structuredClone(state);
  corrupt.recordedMessageIds = [1, 1];
  corrupt.totals.presented = 2;
  const errors = validateBulkReviewSession(corrupt, {
    accountId: "other",
    configRevision: 8,
    request: {kind: "archive", accountId: "work"}
  });

  assert.ok(errors.some(error => error.includes("unique Thunderbird message ids")));
  assert.ok(errors.includes("session account does not match"));
  assert.ok(errors.includes("session config revision does not match"));
  assert.ok(errors.includes("session request does not match"));
});

test("merge validation rejects inconsistent scan accounting", () => {
  assert.throws(
    () => mergePlanScanDelta(session(), {
      planId: "plan-1",
      messages: [message(1), message(2)],
      examined: 4,
      skippedRecorded: 3,
      summary: {total: 2},
      committedAt: "2026-08-12T20:05:00.000Z"
    }),
    /examined cannot be smaller/u
  );
});

test("planner message-id deltas merge into resumable session progress", () => {
  const first = message(1);
  const duplicate = {...first, id: 999};
  const other = message(2);
  const plan = {
    id: "plan-1",
    scanned: 3,
    scanComplete: false,
    stopReason: "action-limit",
    rowsSampled: true,
    bulkExaminedMessageIds: [first.id, duplicate.id, other.id],
    summary: {
      total: 3,
      actionable: 1,
      matched: 1,
      ambiguous: 1,
      unmatched: 1,
      skipped: 0
    }
  };

  const merged = mergeBulkBatch(session(), plan, "2026-08-12T20:05:00.000Z");
  assert.deepEqual(merged.recordedMessageIds, [1, 999, 2]);
  assert.equal(merged.totals.batches, 1);
  assert.equal(merged.totals.examined, 3);
  assert.equal(merged.exhausted, false);
  assert.deepEqual(publicBulkProgress(merged, plan), {
    sessionId: "review-1",
    batchNumber: 1,
    examined: 3,
    totalExamined: 3,
    scanComplete: false,
    stopReason: "action-limit",
    rowsSampled: true
  });
  assert.equal("recordedMessageIds" in publicBulkProgress(merged, plan), false);

  // The planner's ids are progress hints scoped to storage.session; the
  // session retains no destination or other move-shaped authority.
  assert.equal("items" in merged, false);
});

test("planner batches accumulate 4,000 message ids and replay idempotently", () => {
  let state = session();
  let finalPlan;
  for (let batch = 0; batch < 20; batch += 1) {
    const bulkExaminedMessageIds = Array.from(
      {length: 200},
      (_, offset) => batch * 200 + offset + 1
    );
    finalPlan = {
      id: `plan-${batch + 1}`,
      scanned: 200,
      scanComplete: batch === 19,
      stopReason: batch === 19 ? null : "action-limit",
      rowsSampled: false,
      bulkExaminedMessageIds,
      summary: {
        total: 200,
        actionable: 200,
        matched: 200,
        ambiguous: 0,
        unmatched: 0,
        skipped: 0
      }
    };
    state = mergeBulkBatch(state, finalPlan, "2026-08-12T20:05:00.000Z");
  }

  assert.equal(state.recordedMessageIds.length, 4_000);
  assert.equal(state.totals.examined, 4_000);
  assert.equal(state.totals.batches, 20);
  assert.equal(state.exhausted, true);
  assert.deepEqual(
    mergeBulkBatch(state, finalPlan, "2026-08-12T20:06:00.000Z"),
    state
  );
});

test("planner delta validation fails closed on malformed accounting", () => {
  const plan = {
    id: "plan-1",
    scanned: 1,
    scanComplete: false,
    bulkExaminedMessageIds: [1, 2],
    summary: {total: 1}
  };

  assert.throws(() => mergeBulkBatch(session(), plan, CREATED_AT), /must equal/u);
  assert.throws(
    () => mergeBulkBatch(session(), {
      ...plan,
      scanned: 2,
      summary: {total: 2},
      scanComplete: "false"
    }, CREATED_AT),
    /scanComplete must be a boolean/u
  );
});

test("legacy fingerprint sessions restart conservatively during migration", () => {
  const legacy = {
    ...session(),
    schemaVersion: 1,
    recordedOccurrences: {["a".repeat(32)]: 25},
    committedPlanIds: ["legacy-plan"],
    totals: {
      batches: 1,
      examined: 25,
      skippedRecorded: 0,
      presented: 25,
      total: 25,
      actionable: 25,
      matched: 25,
      ambiguous: 0,
      unmatched: 0,
      skipped: 0
    }
  };
  delete legacy.recordedMessageIds;

  const migration = migrateBulkReviewSession(legacy);
  assert.equal(migration.migrated, true);
  assert.deepEqual(migration.session.recordedMessageIds, []);
  assert.deepEqual(migration.session.committedPlanIds, []);
  assert.equal(migration.session.exhausted, false);
  assert.deepEqual(validateBulkReviewSession(migration.session), []);
});

test("persisted-state validation reports hostile timestamp types without throwing", () => {
  const corrupt = session();
  corrupt.createdAt = Symbol("not a timestamp");
  corrupt.updatedAt = null;

  assert.deepEqual(validateBulkReviewSession(corrupt), [
    "createdAt must be a timestamp",
    "updatedAt must be a timestamp"
  ]);
  assert.ok(validateBulkReviewSession(session(), null).includes(
    "expected session constraints must be an object"
  ));
});
