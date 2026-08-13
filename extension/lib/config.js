// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_ACCOUNT_CONFIG,
  DEFAULT_CONFIG
} from "./constants.js";
import {internalDomainsFromIdentities} from "./contacts.js";
import {
  isRegistrableDomain,
  normalizeDomain,
  normalizeEmail,
  validateFolderName
} from "./rules.js";

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizedStringList(values, normalizer) {
  const source = Array.isArray(values) ? values : [];
  return unique(source.map(normalizer).filter(Boolean));
}

function normalizeKeyword(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function randomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `customer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeAccountConfig(value = {}, {existing = true} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const initialized = typeof source.initialized === "boolean"
    ? source.initialized
    : existing;
  const legacyAutomatic = asBoolean(
    source.autoFileIncoming,
    DEFAULT_ACCOUNT_CONFIG.autoFileIncoming
  );
  return {
    initialized,
    enabled: asBoolean(source.enabled, DEFAULT_ACCOUNT_CONFIG.enabled),
    rootFolderName:
      typeof source.rootFolderName === "string" && source.rootFolderName.trim()
        ? source.rootFolderName.trim().normalize("NFC")
        : DEFAULT_ACCOUNT_CONFIG.rootFolderName,
    customerRootReady: asBoolean(
      source.customerRootReady,
      DEFAULT_ACCOUNT_CONFIG.customerRootReady
    ),
    archiveFolderName:
      typeof source.archiveFolderName === "string" && source.archiveFolderName.trim()
        ? source.archiveFolderName.trim().normalize("NFC")
        : DEFAULT_ACCOUNT_CONFIG.archiveFolderName,
    archiveReady: asBoolean(source.archiveReady, DEFAULT_ACCOUNT_CONFIG.archiveReady),
    // autoFileRequested is the user's durable preference. autoFileIncoming is
    // the readiness-gated runtime state. Keeping them separate lets a new
    // account default to automatic filing without running before setup.
    autoFileRequested: asBoolean(
      source.autoFileRequested,
      initialized ? legacyAutomatic : DEFAULT_ACCOUNT_CONFIG.autoFileRequested
    ),
    autoFileIncoming: legacyAutomatic,
    autoFileSince: normalizedTimestamp(source.autoFileSince),
    internalContactDomains: normalizedStringList(
      source.internalContactDomains,
      normalizeDomain
    )
  };
}

export function normalizeCustomer(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const name = typeof source.name === "string" ? source.name.trim() : "";
  const folderName =
    typeof source.folderName === "string" ? source.folderName.trim().normalize("NFC") : "";

  return {
    id: typeof source.id === "string" && source.id ? source.id : randomId(),
    name,
    folderName: folderName || name,
    enabled: asBoolean(source.enabled, true),
    accountIds: unique(
      (Array.isArray(source.accountIds) ? source.accountIds : []).filter(
        accountId => typeof accountId === "string" && accountId
      )
    ),
    domains: normalizedStringList(source.domains, normalizeDomain),
    addresses: normalizedStringList(source.addresses, normalizeEmail),
    keywords: normalizedStringList(source.keywords, normalizeKeyword)
  };
}

export function customerHasUnsafeDomain(customer) {
  return (customer?.domains ?? []).some(domain => !isRegistrableDomain(domain));
}

export function normalizeConfig(raw = {}, accounts = []) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const accountIds = new Set(accounts.map(account => account.id));
  const incomingAccounts = source.accounts && typeof source.accounts === "object" && !Array.isArray(source.accounts)
    ? source.accounts
    : {};
  const normalizedAccounts = {};

  for (const account of accounts) {
    const existing = Object.hasOwn(incomingAccounts, account.id);
    normalizedAccounts[account.id] = normalizeAccountConfig(
      incomingAccounts[account.id],
      {existing}
    );
  }

  // Preserve unavailable account settings. They may become available again after
  // a temporary account or network issue, but never act on them while absent.
  for (const [accountId, value] of Object.entries(incomingAccounts)) {
    if (!accountIds.has(accountId)) {
      normalizedAccounts[accountId] = normalizeAccountConfig(value, {existing: true});
    }
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: boundedInteger(source.revision, DEFAULT_CONFIG.revision, 0, Number.MAX_SAFE_INTEGER),
    defaultDays: [0, 1, 2, 7, 30].includes(Number(source.defaultDays))
      ? Number(source.defaultDays)
      : DEFAULT_CONFIG.defaultDays,
    maxMessagesPerRun: boundedInteger(
      source.maxMessagesPerRun,
      DEFAULT_CONFIG.maxMessagesPerRun,
      25,
      1000
    ),
    scanSubject: asBoolean(source.scanSubject, DEFAULT_CONFIG.scanSubject),
    scanBody: asBoolean(source.scanBody, DEFAULT_CONFIG.scanBody),
    preserveFlagged: asBoolean(source.preserveFlagged, DEFAULT_CONFIG.preserveFlagged),
    accounts: normalizedAccounts,
    customers: (Array.isArray(source.customers) ? source.customers : []).map(normalizeCustomer)
  };
}

export function validateConfig(config, accounts = []) {
  const errors = [];
  const availableAccounts = new Set(accounts.map(account => account.id));
  const availableAccountDetails = new Map(accounts.map(account => [account.id, account]));
  const matcherOwners = new Map();
  const customerIds = new Set();

  for (const [accountId, accountConfig] of Object.entries(config.accounts ?? {})) {
    if (accountConfig.enabled && availableAccounts.size && !availableAccounts.has(accountId)) {
      errors.push(`An enabled account (${accountId}) is no longer available.`);
    }
    const folderError = validateFolderName(accountConfig.rootFolderName);
    if (folderError) {
      errors.push(`Account root folder: ${folderError}`);
    }
    const archiveFolderError = validateFolderName(accountConfig.archiveFolderName);
    if (archiveFolderError) {
      errors.push(`Account archive folder: ${archiveFolderError}`);
    }
    if (
      !folderError &&
      !archiveFolderError &&
      accountConfig.rootFolderName.normalize("NFC").toLocaleLowerCase() ===
        accountConfig.archiveFolderName.normalize("NFC").toLocaleLowerCase()
    ) {
      errors.push("The domain root and archive folders must have different names.");
    }
    const account = availableAccountDetails.get(accountId);
    const identityDomains = internalDomainsFromIdentities(account?.identities);
    const identityDomainSet = new Set(identityDomains);
    for (const domain of accountConfig.internalContactDomains ?? []) {
      if (!isRegistrableDomain(domain)) {
        errors.push(
          `Account ${account?.name ?? accountId}: internal contact domain ${domain} must include an organization name and cannot be a public suffix.`
        );
      } else if (account && !identityDomainSet.has(domain)) {
        errors.push(
          `Account ${account?.name ?? accountId}: internal contact domain ${domain} does not belong to a current account identity. Add or restore that Thunderbird identity before enabling internal capture.`
        );
      }
    }
  }

  for (const [index, customer] of (config.customers ?? []).entries()) {
    const label = customer.name || `Customer ${index + 1}`;
    if (customerIds.has(customer.id)) {
      errors.push(`${label}: customer ID is duplicated. Remove and recreate the duplicated entry.`);
    }
    customerIds.add(customer.id);
    if (!customer.name) {
      errors.push(`Customer ${index + 1} needs a name.`);
    }

    const folderError = validateFolderName(customer.folderName);
    if (folderError) {
      errors.push(`${label}: ${folderError}`);
    }

    if (!customer.enabled) {
      continue;
    }

    if (!customer.domains.length && !customer.addresses.length && !customer.keywords.length) {
      errors.push(`${label} needs at least one domain, address, or keyword.`);
    }

    const scopes = customer.accountIds.length
      ? customer.accountIds
      : availableAccounts.size
        ? [...availableAccounts]
        : ["*"];
    for (const accountId of customer.accountIds) {
      if (availableAccounts.size && !availableAccounts.has(accountId)) {
        errors.push(`${label}: account scope ${accountId} is unavailable. Remap or remove it explicitly.`);
      }
    }
    for (const scope of scopes) {
      const folderKey = `${scope}:folder:${customer.folderName.normalize("NFC").toLocaleLowerCase()}`;
      if (matcherOwners.has(folderKey) && matcherOwners.get(folderKey) !== customer.id) {
        errors.push(`${label}: folder ${customer.folderName} is already assigned to another customer.`);
      }
      matcherOwners.set(folderKey, customer.id);
      for (const domain of customer.domains) {
        if (!isRegistrableDomain(domain)) {
          errors.push(`${label}: domain ${domain} must include an organization name and cannot be a public suffix.`);
          continue;
        }
        const key = `${scope}:domain:${domain}`;
        if (matcherOwners.has(key) && matcherOwners.get(key) !== customer.id) {
          errors.push(`${label}: domain ${domain} is already assigned to another customer.`);
        }
        matcherOwners.set(key, customer.id);
      }
      for (const address of customer.addresses) {
        const key = `${scope}:address:${address}`;
        if (matcherOwners.has(key) && matcherOwners.get(key) !== customer.id) {
          errors.push(`${label}: address ${address} is already assigned to another customer.`);
        }
        matcherOwners.set(key, customer.id);
      }
    }
  }

  return unique(errors);
}

export function accountIsEnabled(config, accountId) {
  return Boolean(config.accounts?.[accountId]?.enabled);
}

export function customerAppliesToAccount(customer, accountId) {
  return (
    customer.enabled &&
    (!customer.accountIds.length || customer.accountIds.includes(accountId))
  );
}

export function customerById(config, customerId) {
  return config.customers.find(customer => customer.id === customerId) ?? null;
}
