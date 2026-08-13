import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MAILBOX_HEADER_CHARACTERS,
  MAX_MAILBOX_HEADER_VALUES,
  MAX_SETTINGS_IMPORT_BYTES,
  assertSettingsImportFileSize,
  boundedMailboxStrings
} from "../extension/lib/input-limits.js";

test("settings imports are rejected before reading files larger than 1 MiB", () => {
  assert.doesNotThrow(() => assertSettingsImportFileSize({
    size: MAX_SETTINGS_IMPORT_BYTES
  }));
  assert.throws(() => assertSettingsImportFileSize({
    size: MAX_SETTINGS_IMPORT_BYTES + 1
  }), /1 MiB or smaller/u);
  assert.throws(() => assertSettingsImportFileSize({}), /determine/u);
});

test("mailbox input is bounded by both total values and total characters", () => {
  const values = Array.from(
    {length: MAX_MAILBOX_HEADER_VALUES + 10},
    (_value, index) => `person-${index}@example.com`
  );
  assert.equal(boundedMailboxStrings(values).length, MAX_MAILBOX_HEADER_VALUES);

  assert.deepEqual(boundedMailboxStrings("x".repeat(
    MAX_MAILBOX_HEADER_CHARACTERS + 100
  )), []);
});

test("mailbox input flattening tolerates nested and cyclic arrays", () => {
  const values = ["one@example.com", ["two@example.com"]];
  values.push(values);
  assert.deepEqual(boundedMailboxStrings(values), [
    "one@example.com",
    "two@example.com"
  ]);
});

test("an oversized mailbox value is ignored rather than truncated into a match", () => {
  const value = `${"x".repeat(MAX_MAILBOX_HEADER_CHARACTERS)}@customer.example.evil`;
  assert.deepEqual(boundedMailboxStrings(value), []);
});
