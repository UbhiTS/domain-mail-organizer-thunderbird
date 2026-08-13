// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
export const CONFIG_KEY = "config";
export const LAST_RUN_KEY = "lastRun";
export const CONFIG_SCHEMA_VERSION = 2;
export const PLAN_KEY_PREFIX = "plan:";
export const CURRENT_PLAN_KEY = "currentPlanId";
export const BULK_SESSION_KEY_PREFIX = "bulkSession:";
export const CURRENT_BULK_SESSION_KEY = "currentBulkSessionId";
export const AUTO_SUPPRESSIONS_KEY = "automaticSuppressions";
export const AUTO_BASELINES_KEY = "automaticNewBaselines";
export const CONTACT_BOOKS_KEY = "managedContactBooks";
export const MAX_BODY_CHARACTERS = 500_000;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  revision: 0,
  defaultDays: 7,
  maxMessagesPerRun: 1000,
  scanSubject: true,
  scanBody: false,
  preserveFlagged: true,
  accounts: {},
  customers: []
});

export const DEFAULT_ACCOUNT_CONFIG = Object.freeze({
  enabled: false,
  rootFolderName: "Customers",
  customerRootReady: false,
  archiveFolderName: "Organizer Archive",
  archiveReady: false,
  autoFileIncoming: false,
  autoFileSince: null
});

export const SOURCE_LABELS = Object.freeze({
  inbox: "Inbox",
  archive: "Organizer Archive",
  selection: "selected messages",
  current: "current folder"
});

export const SPECIAL_SOURCE_TYPES = new Set([
  "junk",
  "trash",
  "drafts",
  "templates",
  "outbox"
]);
