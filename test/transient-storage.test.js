import test from "node:test";
import assert from "node:assert/strict";
import {
  BULK_SESSION_KEY_PREFIX,
  CURRENT_BULK_SESSION_KEY,
  CURRENT_PLAN_KEY,
  PLAN_KEY_PREFIX
} from "../extension/lib/constants.js";
import {storeBulkPlanAndSession} from "../extension/lib/transient-storage.js";

test("bulk plan and progress publish in one temporary-storage write", async () => {
  const values = {
    [CURRENT_PLAN_KEY]: "old-plan",
    [CURRENT_BULK_SESSION_KEY]: "old-session",
    [`${PLAN_KEY_PREFIX}old-plan`]: {id: "old-plan"},
    [`${BULK_SESSION_KEY_PREFIX}old-session`]: {id: "old-session"}
  };
  const writes = [];
  const removals = [];
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.flatMap(key =>
        Object.hasOwn(values, key) ? [[key, structuredClone(values[key])]] : []
      ));
    },
    async set(update) {
      writes.push(structuredClone(update));
      Object.assign(values, structuredClone(update));
    },
    async remove(keys) {
      removals.push(...keys);
      for (const key of keys) delete values[key];
    }
  };
  const plan = {id: "new-plan", items: [{id: 1}]};
  const session = {id: "new-session", totals: {batches: 1}};

  assert.equal(await storeBulkPlanAndSession(plan, session, storage), plan);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]).sort(), [
    CURRENT_BULK_SESSION_KEY,
    CURRENT_PLAN_KEY,
    `${BULK_SESSION_KEY_PREFIX}new-session`,
    `${PLAN_KEY_PREFIX}new-plan`
  ].sort());
  assert.equal(values[CURRENT_PLAN_KEY], plan.id);
  assert.equal(values[CURRENT_BULK_SESSION_KEY], session.id);
  assert.deepEqual(values[`${PLAN_KEY_PREFIX}${plan.id}`], plan);
  assert.deepEqual(values[`${BULK_SESSION_KEY_PREFIX}${session.id}`], session);
  assert.deepEqual(removals.sort(), [
    `${BULK_SESSION_KEY_PREFIX}old-session`,
    `${PLAN_KEY_PREFIX}old-plan`
  ].sort());
});

test("a rejected bulk batch write leaves prior progress and plan intact", async () => {
  const values = {
    [CURRENT_PLAN_KEY]: "old-plan",
    [CURRENT_BULK_SESSION_KEY]: "same-session",
    [`${PLAN_KEY_PREFIX}old-plan`]: {id: "old-plan"},
    [`${BULK_SESSION_KEY_PREFIX}same-session`]: {
      id: "same-session",
      totals: {batches: 1}
    }
  };
  let writes = 0;
  let removes = 0;
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.flatMap(key =>
        Object.hasOwn(values, key) ? [[key, structuredClone(values[key])]] : []
      ));
    },
    async set() {
      writes += 1;
      throw new Error("quota exceeded");
    },
    async remove() {
      removes += 1;
    }
  };

  await assert.rejects(
    storeBulkPlanAndSession(
      {id: "new-plan"},
      {id: "same-session", totals: {batches: 2}},
      storage
    ),
    /entire-Inbox batch was too large.*quota exceeded/
  );
  assert.equal(writes, 1);
  assert.equal(removes, 0);
  assert.equal(values[CURRENT_PLAN_KEY], "old-plan");
  assert.equal(values[CURRENT_BULK_SESSION_KEY], "same-session");
  assert.deepEqual(values[`${BULK_SESSION_KEY_PREFIX}same-session`].totals, {batches: 1});
  assert.equal(values[`${PLAN_KEY_PREFIX}new-plan`], undefined);
});

test("obsolete-value cleanup cannot turn a committed bulk batch into a failure", async () => {
  const storage = {
    async get() {
      return {
        [CURRENT_PLAN_KEY]: "old-plan",
        [CURRENT_BULK_SESSION_KEY]: "old-session"
      };
    },
    async set() {},
    async remove() {
      throw new Error("temporary cleanup failure");
    }
  };
  const plan = {id: "new-plan"};
  const session = {id: "new-session"};

  assert.equal(await storeBulkPlanAndSession(plan, session, storage), plan);
});
