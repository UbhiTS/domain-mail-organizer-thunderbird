// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
export const BULK_REVIEW_SCHEMA_VERSION = 2;

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

function messageId(value, label = "message.id") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function messageIdFrom(value, label = "message") {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return messageId(value.messageId ?? value.id, `${label}.messageId`);
}

function validateMessageIdList(value, label = "recordedMessageIds") {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const ids = value.map((id, index) => messageId(id, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} must contain unique Thunderbird message ids`);
  }
  return ids;
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
    recordedMessageIds: [...session.recordedMessageIds],
    committedPlanIds: [...session.committedPlanIds],
    totals: {...session.totals}
  };
}

/**
 * Create serializable bulk-review bookkeeping. Thunderbird message ids are
 * valid only for the current extension session and are progress hints only.
 * They are never sufficient authority to move a message.
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
    recordedMessageIds: [],
    committedPlanIds: [],
    totals: initialTotals(),
    exhausted: false
  };
}

/**
 * Upgrade the fingerprint-based v1 bookkeeping conservatively. Fingerprint
 * counts cannot be mapped back to exact message ids after reviewed duplicates
 * have moved, so carrying them forward could skip unseen mail. A valid v1
 * session therefore restarts its read-only scan with the same ownership and
 * request. Messages already moved are no longer in Inbox; remaining messages
 * can safely be presented again.
 */
export function migrateBulkReviewSession(value) {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    return {session: value, migrated: false};
  }
  const session = createBulkReviewSession({
    id: value.id,
    accountId: value.accountId,
    configRevision: value.configRevision,
    request: value.request,
    createdAt: value.createdAt
  });
  return {session, migrated: true};
}

/**
 * Return a new id list with the supplied messages recorded. The caller decides
 * when a message has actually been reviewed; this helper performs no mailbox
 * action and rejects duplicate ids rather than silently losing scan progress.
 */
export function recordMessageIds(recordedMessageIds = [], messages) {
  const ids = validateMessageIdList(recordedMessageIds);
  if (!messages || typeof messages[Symbol.iterator] !== "function") {
    throw new TypeError("messages must be iterable");
  }
  const seen = new Set(ids);
  let index = 0;
  for (const value of messages) {
    const id = messageIdFrom(value, `messages[${index}]`);
    if (seen.has(id)) {
      throw new TypeError(`messages[${index}] repeats Thunderbird message id ${id}`);
    }
    seen.add(id);
    ids.push(id);
    index += 1;
  }
  return ids;
}

/**
 * Create a matcher for a fresh Inbox scan. Only the exact session-scoped
 * Thunderbird ids recorded earlier are skipped, so an otherwise identical
 * message remains eligible after its duplicate was moved out of the Inbox.
 */
export function createMessageIdSkipper(recordedMessageIds = []) {
  const recorded = new Set(validateMessageIdList(recordedMessageIds));
  const remaining = new Set(recorded);
  const claimed = new Set();
  let skippedCount = 0;

  return {
    shouldSkip(value) {
      const id = messageIdFrom(value);
      if (!recorded.has(id)) return false;
      remaining.delete(id);
      claimed.add(id);
      skippedCount += 1;
      return true;
    },
    progress() {
      return {
        skippedCount,
        claimedMessageIds: [...claimed],
        remainingMessageIds: [...remaining]
      };
    }
  };
}

/**
 * Commit one deliberately reviewed plan batch into a session. `messages` must
 * contain only messages the caller intends to advance past. A duplicate plan
 * id is idempotent. No destination or action authority is retained.
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
  next.recordedMessageIds = recordMessageIds(next.recordedMessageIds, messages);
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

/** Return progress suitable for UI/runtime responses without private id data. */
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
    reviewed: session.recordedMessageIds.length,
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
 * Commit the exact session-scoped Thunderbird ids emitted by the Inbox
 * planner. This remembers all examined messages, including diagnostics that
 * were not retained as rows, without treating those ids as move authority.
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
  const delta = validateMessageIdList(
    plan.bulkExaminedMessageIds ?? [],
    "plan.bulkExaminedMessageIds"
  );
  const examined = nonNegativeInteger(plan.scanned ?? 0, "plan.scanned");
  if (delta.length !== examined) {
    throw new TypeError("plan.scanned must equal the bulk Thunderbird message id delta");
  }
  const summary = normalizedSummary(plan.summary);
  if (summary.total !== examined) {
    throw new TypeError("plan.summary.total must equal plan.scanned");
  }
  const normalizedCommittedAt = timestamp(committedAt, "committedAt");
  const next = cloneSession(session);
  next.recordedMessageIds = recordMessageIds(
    next.recordedMessageIds,
    delta.map(id => ({messageId: id}))
  );
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

/** Public metadata attached to an organizer plan; message-id state stays private. */
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

  let recordedMessageIds = null;
  try {
    recordedMessageIds = validateMessageIdList(session.recordedMessageIds);
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
      recordedMessageIds &&
      session.totals.presented !== recordedMessageIds.length
    ) {
      errors.push("totals.presented does not match recorded message ids");
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
