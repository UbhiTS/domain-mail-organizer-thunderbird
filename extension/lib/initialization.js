// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT

/**
 * A true first run has no initialized record for any account Thunderbird can
 * currently use. Saving settings initializes even explicitly disabled and
 * partially configured accounts, so those states remain visible in the popup.
 * Stale records for removed accounts do not reveal unusable controls.
 */
export function hasInitializedAvailableAccount(config, accounts) {
  return (Array.isArray(accounts) ? accounts : []).some(account =>
    typeof account?.id === "string" &&
    config?.accounts?.[account.id]?.initialized === true
  );
}
