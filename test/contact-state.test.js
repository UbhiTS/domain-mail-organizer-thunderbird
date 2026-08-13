import test from "node:test";
import assert from "node:assert/strict";
import {normalizeManagedContactBooks} from "../extension/lib/contact-state.js";

test("managed contact-book state accepts only complete string ownership records", () => {
  assert.deepEqual(normalizeManagedContactBooks({
    work: {
      addressBookId: " managed-id ",
      addressBookName: " Customer Contacts — Work "
    },
    missingName: {addressBookId: "id"},
    badId: {addressBookId: true, addressBookName: "Book"},
    empty: null
  }), {
    work: {
      addressBookId: "managed-id",
      addressBookName: "Customer Contacts — Work"
    }
  });
  assert.deepEqual(normalizeManagedContactBooks("not an object"), {});
  assert.deepEqual(normalizeManagedContactBooks([]), {});
});
