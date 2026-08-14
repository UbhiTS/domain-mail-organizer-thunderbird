// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";

import {
  managedContactBookName,
  setupManagedContactBook
} from "../extension/lib/contact-book.js";

const account = {id: "work", name: "Work"};
const expectedName = managedContactBookName(account);

function addressBook(id, name = expectedName, overrides = {}) {
  return {
    id,
    name,
    type: "addressBook",
    remote: false,
    readOnly: false,
    ...overrides
  };
}

function setupApi(books) {
  const createCalls = [];
  return {
    createCalls,
    api: {
      addressBooks: {
        list: async () => books,
        create: async properties => {
          createCalls.push(properties);
          return "new-managed-book";
        }
      }
    }
  };
}

test("setup adopts one exact-name local writable address book", async () => {
  const {api, createCalls} = setupApi([
    addressBook("personal", "Personal Address Book"),
    addressBook("existing-customer-contacts")
  ]);

  const result = await setupManagedContactBook(account, null, api);

  assert.deepEqual(result, {
    accountId: "work",
    addressBookId: "existing-customer-contacts",
    addressBookName: expectedName,
    created: false
  });
  assert.deepEqual(createCalls, []);
});

test("setup rejects multiple exact-name address books as ambiguous", async () => {
  const {api, createCalls} = setupApi([
    addressBook("same-name-one"),
    addressBook("same-name-two")
  ]);

  await assert.rejects(
    setupManagedContactBook(account, null, api),
    /ambiguous|multiple|more than one/iu
  );
  assert.deepEqual(createCalls, []);
});

test("setup rejects a unique exact-name remote or read-only address book", async t => {
  const cases = [
    ["remote", {remote: true}, /must be local/iu],
    ["read-only", {readOnly: true}, /read-only/iu]
  ];

  for (const [label, overrides, expectedError] of cases) {
    await t.test(label, async () => {
      const {api, createCalls} = setupApi([
        addressBook(`existing-${label}`, expectedName, overrides)
      ]);

      await assert.rejects(
        setupManagedContactBook(account, null, api),
        expectedError
      );
      assert.deepEqual(createCalls, []);
    });
  }
});

test("setup preserves a valid stored address-book ID", async () => {
  const {api, createCalls} = setupApi([
    addressBook("personal", "Personal Address Book"),
    addressBook("stored-managed-book")
  ]);

  const result = await setupManagedContactBook(account, {
    addressBookId: "stored-managed-book",
    addressBookName: expectedName
  }, api);

  assert.deepEqual(result, {
    accountId: "work",
    addressBookId: "stored-managed-book",
    addressBookName: expectedName,
    created: false
  });
  assert.deepEqual(createCalls, []);
});

test("setup repairs a stale stored ID by adopting one exact-name local writable book", async () => {
  const {api, createCalls} = setupApi([
    addressBook("replacement-existing-book")
  ]);

  const result = await setupManagedContactBook(account, {
    addressBookId: "deleted-managed-book",
    addressBookName: expectedName
  }, api);

  assert.deepEqual(result, {
    accountId: "work",
    addressBookId: "replacement-existing-book",
    addressBookName: expectedName,
    created: false
  });
  assert.deepEqual(createCalls, []);
});

test("setup does not abandon a resolved but invalid stored ID for a same-name book", async () => {
  const {api, createCalls} = setupApi([
    addressBook("stored-managed-book", "Renamed customer contacts"),
    addressBook("same-name-fallback")
  ]);

  await assert.rejects(
    setupManagedContactBook(account, {
      addressBookId: "stored-managed-book",
      addressBookName: expectedName
    }, api),
    /was renamed/iu
  );
  assert.deepEqual(createCalls, []);
});
