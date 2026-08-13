// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
const FIELD_SEPARATOR = "\u001f";
const UINT64_MASK = (1n << 64n) - 1n;
const FNV_PRIME = 0x100000001b3n;

function clipped(value, maximum) {
  return String(value ?? "").slice(0, maximum);
}

function messageDateValue(message) {
  if (message?.date instanceof Date) {
    return message.date.toISOString();
  }
  return message?.date ?? "";
}

function recipientValue(message) {
  if (typeof message?.recipients === "string") {
    return message.recipients;
  }
  return [
    ...(message?.recipients ?? []),
    ...(message?.ccList ?? []),
    ...(message?.bccList ?? [])
  ].join(", ");
}

export function messageFingerprint(message, missingMessageId = "") {
  const value = [
    clipped(message?.headerMessageId || missingMessageId, 320),
    messageDateValue(message),
    clipped(message?.author, 320),
    clipped(recipientValue(message), 500),
    clipped(message?.subject, 320),
    message?.size ?? ""
  ].join(FIELD_SEPARATOR);
  // Keep the durable Inbox census compact. Forward and reverse 64-bit FNV-1a
  // passes provide a 128-bit local identity without persisting full headers.
  // This is a conservative occurrence fingerprint, not a Thunderbird ID.
  let forward = 0xcbf29ce484222325n;
  let reverse = 0x84222325cbf29ce4n;
  for (let index = 0; index < value.length; index += 1) {
    forward ^= BigInt(value.charCodeAt(index));
    forward = (forward * FNV_PRIME) & UINT64_MASK;
    reverse ^= BigInt(value.charCodeAt(value.length - index - 1));
    reverse = (reverse * FNV_PRIME) & UINT64_MASK;
  }
  return `${forward.toString(16).padStart(16, "0")}${reverse.toString(16).padStart(16, "0")}`;
}

export function accountMessageFingerprint(accountId, message) {
  return [
    accountId,
    messageFingerprint(message, "no-message-id")
  ].join(FIELD_SEPARATOR);
}
