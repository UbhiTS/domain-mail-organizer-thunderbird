// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
function messageTimestamp(item) {
  const timestamp = Date.parse(item?.date ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function newestMessagesFirst(items = []) {
  return [...items].sort((left, right) => {
    const leftTimestamp = messageTimestamp(left);
    const rightTimestamp = messageTimestamp(right);
    if (leftTimestamp === null) return rightTimestamp === null ? 0 : 1;
    if (rightTimestamp === null) return -1;
    return rightTimestamp - leftTimestamp;
  });
}

function customerName(customer) {
  return String(customer?.name ?? "").trim().normalize("NFC");
}

export function customersByName(customers = [], locale = undefined) {
  const collator = new Intl.Collator(locale, {
    sensitivity: "base",
    numeric: true
  });
  return customers
    .map((customer, index) => ({customer, index, name: customerName(customer)}))
    .sort((left, right) => {
      if (!left.name) return right.name ? 1 : left.index - right.index;
      if (!right.name) return -1;
      return collator.compare(left.name, right.name) || left.index - right.index;
    })
    .map(entry => entry.customer);
}
