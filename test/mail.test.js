import test from "node:test";
import assert from "node:assert/strict";
import {collectMessageList, parseMailboxValues} from "../extension/lib/mail.js";

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
