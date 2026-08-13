// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT

/** Normalize untrusted address-book ownership state from storage.local. */
export function normalizeManagedContactBooks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [accountId, entry] of Object.entries(value)) {
    const addressBookId = typeof entry?.addressBookId === "string"
      ? entry.addressBookId.trim()
      : "";
    const addressBookName = typeof entry?.addressBookName === "string"
      ? entry.addressBookName.trim().normalize("NFC")
      : "";
    if (!accountId || !addressBookId || !addressBookName) continue;
    normalized[accountId] = {addressBookId, addressBookName};
  }
  return normalized;
}
