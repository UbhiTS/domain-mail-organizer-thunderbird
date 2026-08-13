import test from "node:test";
import assert from "node:assert/strict";
import {collectMessageList, parseMailboxValues} from "../extension/lib/mail.js";
import {
  MAX_MAILBOX_HEADER_CHARACTERS,
  MAX_MAILBOX_HEADER_VALUES
} from "../extension/lib/input-limits.js";

test("consumes every message-list page", async () => {
  const pages = new Map([
    ["next-1", {id: "next-2", messages: [{id: 2}]}],
    ["next-2", {id: null, messages: [{id: 3}]}]
  ]);
  const api = {
    messages: {
      continueList: async id => pages.get(id),
      abortList: async () => assert.fail("should not abort")
    }
  };
  const result = await collectMessageList(
    Promise.resolve({id: "next-1", messages: [{id: 1}]}),
    10,
    api
  );
  assert.deepEqual(result.messages.map(message => message.id), [1, 2, 3]);
  assert.equal(result.truncated, false);
});

test("stops at the configured safety limit and aborts remaining pagination", async () => {
  let aborted;
  const api = {
    messages: {
      continueList: async () => assert.fail("first page already exceeds limit"),
      abortList: async id => { aborted = id; }
    }
  };
  const result = await collectMessageList(
    {id: "remaining", messages: [{id: 1}, {id: 2}, {id: 3}]},
    2,
    api
  );
  assert.deepEqual(result.messages.map(message => message.id), [1, 2]);
  assert.equal(result.truncated, true);
  assert.equal(aborted, "remaining");
});

test("uses Thunderbird mailbox parsing and flattens groups", async () => {
  const api = {
    messengerUtilities: {
      parseMailboxString: async () => [
        {email: "A@EXAMPLE.COM"},
        {group: [{email: "b@other.example"}]}
      ]
    }
  };
  assert.deepEqual(
    await parseMailboxValues(["ignored by mock"], api),
    ["a@example.com", "b@other.example"]
  );
});

test("bounds Thunderbird parsing by mailbox value count and total characters", async () => {
  const calls = [];
  const api = {
    messengerUtilities: {
      parseMailboxString: async value => {
        calls.push(value);
        return [];
      }
    }
  };
  await parseMailboxValues(Array.from(
    {length: MAX_MAILBOX_HEADER_VALUES + 10},
    (_value, index) => `person-${index}@example.com`
  ), api);
  assert.equal(calls.length, MAX_MAILBOX_HEADER_VALUES);

  calls.length = 0;
  await parseMailboxValues("x".repeat(MAX_MAILBOX_HEADER_CHARACTERS + 100), api);
  assert.equal(calls.length, 0);
});

test("bounds mailbox input before the regex fallback", async () => {
  const api = {
    messengerUtilities: {
      parseMailboxString: async () => {
        throw new Error("parser unavailable");
      }
    }
  };
  const value = `early@example.com, ${"x".repeat(MAX_MAILBOX_HEADER_CHARACTERS)}, late@example.com`;
  assert.deepEqual(await parseMailboxValues(value, api), []);
});
