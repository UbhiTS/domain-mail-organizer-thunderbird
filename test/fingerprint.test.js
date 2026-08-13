import test from "node:test";
import assert from "node:assert/strict";

import {
  accountMessageFingerprint,
  messageFingerprint
} from "../extension/lib/fingerprint.js";

test("message fingerprints are identical for stored headers and plan items", () => {
  const header = {
    headerMessageId: "<message@example.test>",
    date: new Date("2026-08-12T12:00:00.000Z"),
    author: "Customer <person@example.test>",
    subject: "Project update"
  };
  const planItem = {
    ...header,
    date: "2026-08-12T12:00:00.000Z"
  };

  assert.equal(messageFingerprint(header), messageFingerprint(planItem));
  assert.match(messageFingerprint(header), /^[a-f0-9]{32}$/u);
  assert.equal(
    accountMessageFingerprint("work", header),
    accountMessageFingerprint("work", planItem)
  );
});

test("messages without Message-ID still receive a stable account fingerprint", () => {
  const message = {
    date: "2026-08-12T12:00:00.000Z",
    author: "Customer <person@example.test>",
    subject: "Project update"
  };

  assert.equal(
    accountMessageFingerprint("work", message),
    accountMessageFingerprint("work", {...message})
  );
  assert.notEqual(
    accountMessageFingerprint("work", message),
    accountMessageFingerprint("other", message)
  );
});
