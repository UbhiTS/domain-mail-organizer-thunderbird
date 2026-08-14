// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";

import {hasInitializedAvailableAccount} from "../extension/lib/initialization.js";

const available = [{id: "work"}, {id: "personal"}];

test("fresh accounts keep popup processing controls hidden", () => {
  assert.equal(hasInitializedAvailableAccount({
    accounts: {
      work: {initialized: false},
      personal: {initialized: false}
    }
  }, available), false);
  assert.equal(hasInitializedAvailableAccount(null, available), false);
  assert.equal(hasInitializedAvailableAccount({accounts: {}}, null), false);
});

test("explicit disabled and partially configured available accounts reveal controls", () => {
  assert.equal(hasInitializedAvailableAccount({
    accounts: {work: {initialized: true, enabled: false}}
  }, available), true);

  assert.equal(hasInitializedAvailableAccount({
    accounts: {
      work: {
        initialized: true,
        enabled: true,
        customerRootReady: false
      }
    }
  }, available), true);
});

test("stale initialized records for unavailable accounts do not reveal controls", () => {
  assert.equal(hasInitializedAvailableAccount({
    accounts: {
      removed: {initialized: true},
      work: {initialized: false}
    }
  }, available), false);
});
