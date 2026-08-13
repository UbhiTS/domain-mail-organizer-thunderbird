// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT

export const MAX_SETTINGS_IMPORT_BYTES = 1024 * 1024;
export const MAX_MAILBOX_HEADER_VALUES = 256;
export const MAX_MAILBOX_HEADER_CHARACTERS = 16 * 1024;

export function assertSettingsImportFileSize(file) {
  const size = file?.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError("Could not determine the settings JSON file size");
  }
  if (size > MAX_SETTINGS_IMPORT_BYTES) {
    throw new RangeError("Settings JSON must be 1 MiB or smaller");
  }
}

/**
 * Flatten Thunderbird mailbox header values while placing a hard upper bound
 * on parser work. Values after either limit are deliberately ignored.
 */
export function boundedMailboxStrings(values) {
  const root = Array.isArray(values) ? values : [values];
  const seenArrays = new WeakSet([root]);
  const stack = [{array: root, index: 0}];
  const strings = [];
  let characters = 0;

  while (stack.length &&
    strings.length < MAX_MAILBOX_HEADER_VALUES &&
    characters < MAX_MAILBOX_HEADER_CHARACTERS) {
    const frame = stack.at(-1);
    if (frame.index >= frame.array.length) {
      stack.pop();
      continue;
    }

    const value = frame.array[frame.index];
    frame.index += 1;
    if (Array.isArray(value)) {
      if (!seenArrays.has(value)) {
        seenArrays.add(value);
        stack.push({array: value, index: 0});
      }
      continue;
    }
    if (typeof value !== "string" || !value) {
      continue;
    }

    const remaining = MAX_MAILBOX_HEADER_CHARACTERS - characters;
    // Never truncate a mailbox string: truncating `user@example.com.evil`
    // after `.com` could turn an untrusted non-match into a valid match.
    // Ignore the oversized value in full and fail closed instead.
    if (value.length > remaining) {
      break;
    }
    strings.push(value);
    characters += value.length;
  }

  return strings;
}
