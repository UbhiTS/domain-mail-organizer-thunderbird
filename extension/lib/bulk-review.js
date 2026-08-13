// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {messageFingerprint} from "./fingerprint.js";

export const BULK_REVIEW_SCHEMA_VERSION = 1;

const SUMMARY_FIELDS = Object.freeze([
  "total",
  "actionable",
  "matched",
  "ambiguous",
  "unmatched",
  "skipped"
]);

const TOTAL_FIELDS = Object.freeze([
  "batches",
  "examined",
  "skippedRecorded",
  "presented",
  ...SUMMARY_FIELDS
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(value, path = "request") {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalJsonValue(value[key], `${path}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`${path} must contain only JSON-compatible values`);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-compatible timestamp`);
  }
  return new Date(value).toISOString();
}

function validateCountMap(value, label = "recordedOccurrences") {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const counts = {};
  for (const [fingerprint, count] of Object.entries(value)) {
    if (!/^[a-f0-9]{32}$/u.test(fingerprint)) {
      throw new TypeError(`${label} contains an invalid message fingerprint`);
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError(`${label}.${fingerprint} must be a positive safe integer`);
    }
    counts[fingerprint] = count;
  }
  return counts;
}

function countOccurrences(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function addSafeCounts(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError(`${label} exceeds the safe integer range`);
  }
  return total;
}

function initialTotals() {
  return Object.fromEntries(TOTAL_FIELDS.map(field => [field, 0]));
}

function normalizedSummary(summary = {}) {
  if (!isPlainObject(summary)) {
    throw new TypeError("summary must be an object");
  }
  return Object.fromEntries(
    SUMMARY_FIELDS.map(field => [
      field,
      nonNegativeInteger(summary[field] ?? 0, `summary.${field}`)
    ])
  );
}

function cloneSession(session) {
  return {
    ...session,
    request: canonicalJsonValue(session.request),
    recordedOccurrences: {...session.recordedOccurrences},
    committedPlanIds: [...session.committedPlanIds],
    totals: {...session.totals}
  };
}

/**
 * Create serializable bulk-review bookkeeping. The recorded fingerprints are
 * progress hints only. They are never sufficient authority to move a message.
 */
export function createBulkReviewSession({
  id,
  accountId,
  configRevision,
  request,
  createdAt = new Date().toISOString()
}) {
  const normalizedId = nonEmptyString(id, "id");
  const normalizedAccountId = nonEmptyString(accountId, "accountId");
  const normalizedRequest = canonicalJsonValue(request);
  if (!isPlainObject(normalizedRequest)) {
    throw new TypeError("request must be an object");
  }
  if (
    normalizedRequest.accountId !== undefined &&
    normalizedRequest.accountId !== normalizedAccountId
  ) {
    throw new TypeError("request.accountId must match accountId");
  }
  const normalizedCreatedAt = timestamp(createdAt, "createdAt");
  return {
    schemaVersion: BULK_REVIEW_SCHEMA_VERSION,
    id: normalizedId,
    accountId: normalizedAccountId,
    configRevision: nonNegativeInteger(configRevision, "configRevision"),
    request: normalizedRequest,
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedCreatedAt,
    recordedOccurrences: {},
    committedPlanIds: [],
    totals: initialTotals(),
    exhausted: false
  };
}

/**
 * Return a new occurrence-count map with the supplied messages recorded. The
 * caller decides when a message has actually been reviewed; this helper stores
 * no Thunderbird message id and performs no mailbox action.
 */
export function recordFingerprintOccurrences(recordedOccurrences = {}, messages) {
  const counts = validateCountMap(recordedOccurrences);
  if (!messages || typeof messages[Symbol.iterator] !== "function") {
    throw new TypeError("messages must be iterable");
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      throw new TypeError("each message must be an object");
    }
    const fingerprint = messageFingerprint(message);
    counts[fingerprint] = addSafeCounts(
      counts[fingerprint] ?? 0,
      1,
      `recordedOccurrences.${fingerprint}`
    );
  }
  return counts;
}

/**
 * Create a consuming multiset matcher for a fresh Inbox scan. If N occurrences
 * were previously recorded, exactly the first N matching occurrences are
 * skipped; an additional identical occurrence remains eligible for review.
 */
export function createFingerprintSkipper(recordedOccurrences = {}) {
  const remaining = validateCountMap(recordedOccurrences);
  const claimedOccurrences = {};
  let skippedCount = 0;

  return {
    shouldSkip(message) {
      if (!message || typeof message !== "object") {
        throw new TypeError("message must be an object");
      }
      const fingerprint = messageFingerprint(message);
      if (!remaining[fingerprint]) return false;
      remaining[fingerprint] -= 1;
      if (!remaining[fingerprint]) delete remaining[fingerprint];
      claimedOccurrences[fingerprint] = (claimedOccurrences[fingerprint] ?? 0) + 1;
      skippedCount += 1;
      return true;
    },
    progress() {
      return {
        skippedCount,
        claimedOccurrences: {...claimedOccurrences},
        remainingOccurrences: {...remaining}
      };
    }
  };
}

/**
 * Commit one deliberately reviewed plan batch into a session. `messages` must
 * contain only occurrences the caller intends to advance past. A duplicate
 * plan id is idempotent. No message id, destination, or action is retained.
 */
export function mergePlanScanDelta(session, {
  planId,
  messages,
  examined,
  skippedRecorded = 0,
  summary = {},
  exhausted = false,
  committedAt = new Date().toISOString()
}) {
  const sessionErrors = validateBulkReviewSession(session);
  if (sessionErrors.length) {
    throw new TypeError(`Invalid bulk-review session: ${sessionErrors.join("; ")}`);
  }
  const normalizedPlanId = nonEmptyString(planId, "planId");
  if (session.committedPlanIds.includes(normalizedPlanId)) {
    return cloneSession(session);
  }
  if (session.exhausted) {
    throw new Error("Cannot merge another plan into an exhausted bulk-review session");
  }
  if (!Array.isArray(messages)) {
    throw new TypeError("messages must be an array");
  }
  const normalizedExamined = nonNegativeInteger(examined, "examined");
  const normalizedSkipped = nonNegativeInteger(skippedRecorded, "skippedRecorded");
  if (normalizedExamined < normalizedSkipped + messages.length) {
    throw new TypeError("examined cannot be smaller than skippedRecorded plus messages");
  }
  if (typeof exhausted !== "boolean") {
    throw new TypeError("exhausted must be a boolean");
  }
  const normalizedCommittedAt = timestamp(committedAt, "committedAt");
  if (Date.parse(normalizedCommittedAt) < Date.parse(session.updatedAt)) {
    throw new TypeError("committedAt cannot be earlier than the session update time");
  }
  const normalizedPlanSummary = normalizedSummary(summary);
  if (normalizedPlanSummary.total < messages.length) {
    throw new TypeError("summary.total cannot be smaller than messages.length");
  }

  const next = cloneSession(session);
  next.recordedOccurrences = recordFingerprintOccurrences(
    next.recordedOccurrences,
    messages
  );
  next.committedPlanIds.push(normalizedPlanId);
  next.totals.batches += 1;
  next.totals.examined += normalizedExamined;
  next.totals.skippedRecorded += normalizedSkipped;
  next.totals.presented += messages.length;
  for (const field of SUMMARY_FIELDS) {
    next.totals[field] += normalizedPlanSummary[field];
  }
  next.exhausted = exhausted;
  next.updatedAt = normalizedCommittedAt;
  return next;
}

/** Return progress suitable for UI/runtime responses without fingerprint data. */
export function publicBulkReviewProgress(session) {
  const errors = validateBulkReviewSession(session);
  if (errors.length) {
    throw new TypeError(`Invalid bulk-review session: ${errors.join("; ")}`);
  }
  return {
    sessionId: session.id,
    accountId: session.accountId,
    configRevision: session.configRevision,
    batches: session.totals.batches,
    examined: session.totals.examined,
    reviewed: countOccurrences(session.recordedOccurrences),
    skippedPreviouslyReviewed: session.totals.skippedRecorded,
    presented: session.totals.presented,
    actionable: session.totals.actionable,
    matched: session.totals.matched,
    ambiguous: session.totals.ambiguous,
    unmatched: session.totals.unmatched,
    skipped: session.totals.skipped,
    exhausted: session.exhausted,
    updatedAt: session.updatedAt
  };
}

/**
 * Commit the compact fingerprint-count delta emitted by the Inbox planner.
 * This is the integration form used by the background page: it remembers all
 * examined occurrences, including diagnostics that were not retained as rows.
 */
export function mergeBulkBatch(session, plan, committedAt = new Date().toISOString()) {
  const errors = validateBulkReviewSession(session);
  if (errors.length) {
    throw new TypeError(`Invalid bulk-review session: ${errors.join("; ")}`);
  }
  const planId = nonEmptyString(plan?.id, "plan.id");
  if (session.committedPlanIds.includes(planId)) {
    return cloneSession(session);
  }
  if (session.exhausted) {
    throw new Error("Cannot merge another plan into an exhausted bulk-review session");
  }
  const delta = validateCountMap(plan.bulkExaminedCounts ?? {}, "plan.bulkExaminedCounts");
  const examined = nonNegativeInteger(plan.scanned ?? 0, "plan.scanned");
  if (countOccurrences(delta) !== examined) {
    throw new TypeError("plan.scanned must equal the bulk fingerprint occurrence delta");
  }
  const summary = normalizedSummary(plan.summary);
  if (summary.total !== examined) {
    throw new TypeError("plan.summary.total must equal plan.scanned");
  }
  const normalizedCommittedAt = timestamp(committedAt, "committedAt");
  const next = cloneSession(session);
  for (const [fingerprint, count] of Object.entries(delta)) {
    next.recordedOccurrences[fingerprint] = addSafeCounts(
      next.recordedOccurrences[fingerprint] ?? 0,
      count,
      `recordedOccurrences.${fingerprint}`
    );
  }
  next.committedPlanIds.push(planId);
  next.totals.batches += 1;
  next.totals.examined += examined;
  next.totals.presented += examined;
  for (const field of SUMMARY_FIELDS) {
    next.totals[field] += summary[field];
  }
  if (typeof plan.scanComplete !== "boolean") {
    throw new TypeError("plan.scanComplete must be a boolean");
  }
  if (Date.parse(normalizedCommittedAt) < Date.parse(session.updatedAt)) {
    throw new TypeError("committedAt cannot be earlier than the session update time");
  }
  next.exhausted = plan.scanComplete;
  next.updatedAt = normalizedCommittedAt;
  return next;
}

/** Public metadata attached to an organizer plan; fingerprint state stays private. */
export function publicBulkProgress(session, plan) {
  const progress = publicBulkReviewProgress(session);
  return {
    sessionId: session.id,
    batchNumber: session.totals.batches,
    examined: Number(plan?.scanned) || 0,
    totalExamined: progress.examined,
    scanComplete: session.exhausted,
    stopReason: plan?.stopReason ?? null,
    rowsSampled: Boolean(plan?.rowsSampled)
  };
}

/**
 * Validate persisted state and, optionally, its ownership boundary. Returns
 * human-readable errors rather than throwing so callers can discard stale or
 * malformed state safely.
 */
export function validateBulkReviewSession(session, expected = {}) {
  const errors = [];
  if (!isPlainObject(session)) {
    return ["session must be an object"];
  }
  if (session.schemaVersion !== BULK_REVIEW_SCHEMA_VERSION) {
    errors.push("schemaVersion is unsupported");
  }
  if (typeof session.id !== "string" || !session.id.trim()) {
    errors.push("id must be a non-empty string");
  }
  if (typeof session.accountId !== "string" || !session.accountId.trim()) {
    errors.push("accountId must be a non-empty string");
  }
  if (!Number.isSafeInteger(session.configRevision) || session.configRevision < 0) {
    errors.push("configRevision must be a non-negative safe integer");
  }
  let normalizedRequest = null;
  try {
    normalizedRequest = canonicalJsonValue(session.request);
    if (!isPlainObject(normalizedRequest)) {
      errors.push("request must be an object");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (
    normalizedRequest?.accountId !== undefined &&
    normalizedRequest.accountId !== session.accountId
  ) {
    errors.push("request.accountId does not match accountId");
  }
  const parsedTimestamps = {};
  for (const field of ["createdAt", "updatedAt"]) {
    parsedTimestamps[field] = typeof session[field] === "string"
      ? Date.parse(session[field])
      : Number.NaN;
    if (!Number.isFinite(parsedTimestamps[field])) {
      errors.push(`${field} must be a timestamp`);
    }
  }
  if (
    Number.isFinite(parsedTimestamps.createdAt) &&
    Number.isFinite(parsedTimestamps.updatedAt) &&
    parsedTimestamps.updatedAt < parsedTimestamps.createdAt
  ) {
    errors.push("updatedAt cannot be earlier than createdAt");
  }

  let recordedOccurrences = null;
  try {
    recordedOccurrences = validateCountMap(session.recordedOccurrences);
  } catch (error) {
    errors.push(error.message);
  }
  if (
    !Array.isArray(session.committedPlanIds) ||
    session.committedPlanIds.some(id => typeof id !== "string" || !id.trim())
  ) {
    errors.push("committedPlanIds must contain non-empty strings");
  } else if (new Set(session.committedPlanIds).size !== session.committedPlanIds.length) {
    errors.push("committedPlanIds must be unique");
  }
  if (!isPlainObject(session.totals)) {
    errors.push("totals must be an object");
  } else {
    for (const field of TOTAL_FIELDS) {
      if (!Number.isSafeInteger(session.totals[field]) || session.totals[field] < 0) {
        errors.push(`totals.${field} must be a non-negative safe integer`);
      }
    }
    if (
      Array.isArray(session.committedPlanIds) &&
      session.totals.batches !== session.committedPlanIds.length
    ) {
      errors.push("totals.batches does not match committedPlanIds");
    }
    if (
      recordedOccurrences &&
      session.totals.presented !== countOccurrences(recordedOccurrences)
    ) {
      errors.push("totals.presented does not match recorded occurrences");
    }
  }
  if (typeof session.exhausted !== "boolean") {
    errors.push("exhausted must be a boolean");
  }

  if (!isPlainObject(expected)) {
    errors.push("expected session constraints must be an object");
    return errors;
  }
  if (expected.id !== undefined && expected.id !== session.id) {
    errors.push("session id does not match");
  }
  if (expected.accountId !== undefined && expected.accountId !== session.accountId) {
    errors.push("session account does not match");
  }
  if (
    expected.configRevision !== undefined &&
    expected.configRevision !== session.configRevision
  ) {
    errors.push("session config revision does not match");
  }
  if (expected.request !== undefined) {
    try {
      const expectedRequest = canonicalJsonValue(expected.request, "expected.request");
      if (JSON.stringify(expectedRequest) !== JSON.stringify(normalizedRequest)) {
        errors.push("session request does not match");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}
