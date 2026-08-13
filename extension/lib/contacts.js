// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  domainFromEmail,
  fallbackParseMailboxString,
  isRegistrableDomain,
  normalizeDomain,
  normalizeEmail
} from "./rules.js";
import {boundedMailboxStrings} from "./input-limits.js";

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function flattenMailboxEntries(entries) {
  const candidates = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.email) {
      candidates.push({
        name: normalizeDisplayName(entry.name),
        email: entry.email
      });
    }
    if (Array.isArray(entry.group)) {
      candidates.push(...flattenMailboxEntries(entry.group));
    }
  }
  return candidates;
}

function fallbackMailboxCandidates(value) {
  return fallbackParseMailboxString(value).map(email => ({name: "", email}));
}

/**
 * Normalize candidates and deduplicate them by exact normalized email address.
 * A later display name fills an earlier blank one without changing order.
 */
export function normalizeContactCandidates(candidates) {
  const normalized = [];
  const indexes = new Map();

  for (const candidate of candidates ?? []) {
    const email = normalizeEmail(candidate?.email);
    if (!email) {
      continue;
    }
    const name = normalizeDisplayName(candidate?.name);
    const existingIndex = indexes.get(email);
    if (existingIndex === undefined) {
      indexes.set(email, normalized.length);
      normalized.push({name, email});
    } else if (!normalized[existingIndex].name && name) {
      normalized[existingIndex] = {name, email};
    }
  }

  return normalized;
}

/** Parse one or more RFC mailbox header values using Thunderbird's parser. */
export async function parseMailboxCandidates(values, api = globalThis.messenger) {
  const parsedValues = await Promise.all(
    boundedMailboxStrings(values).map(async value => {
      try {
        const entries = await api.messengerUtilities.parseMailboxString(value, true);
        return flattenMailboxEntries(entries);
      } catch {
        return fallbackMailboxCandidates(value);
      }
    })
  );
  return normalizeContactCandidates(parsedValues.flat());
}

/**
 * Derive the exact organization domains represented by an account's identities.
 * Public suffixes and malformed identity addresses are deliberately ignored.
 */
export function internalDomainsFromIdentities(identities) {
  const domains = [];
  const seen = new Set();
  for (const identity of identities ?? []) {
    const email = normalizeEmail(
      typeof identity === "string" ? identity : identity?.email
    );
    const domain = domainFromEmail(email);
    if (!domain || seen.has(domain) || !isRegistrableDomain(domain)) {
      continue;
    }
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

/**
 * Keep only configured internal domains that are still represented by a
 * current identity on the same Thunderbird account.
 */
export function approvedInternalDomains(identities, configuredDomains) {
  const identityDomains = new Set(internalDomainsFromIdentities(identities));
  const approved = [];
  const seen = new Set();
  for (const value of configuredDomains ?? []) {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain) || !identityDomains.has(domain)) {
      continue;
    }
    seen.add(domain);
    approved.push(domain);
  }
  return approved;
}

/** Parse every address-bearing header on a message exactly once. */
export async function parseMessageContactCandidates(
  header,
  api = globalThis.messenger
) {
  return parseMailboxCandidates(
    [
      header?.author,
      header?.recipients ?? [],
      header?.ccList ?? [],
      header?.bccList ?? []
    ],
    api
  );
}

function normalizedOwnIdentityEmails(ownIdentityEmails) {
  return new Set(
    (ownIdentityEmails ?? [])
      .map(value => normalizeEmail(typeof value === "string" ? value : value?.email))
      .filter(Boolean)
  );
}

/**
 * Keep only exact addresses or exact domains configured for one customer.
 * Configuring example.com deliberately does not include sub.example.com.
 */
export function filterCustomerContactCandidates(
  candidates,
  customer,
  ownIdentityEmails = []
) {
  const addresses = new Set(
    (customer?.addresses ?? []).map(normalizeEmail).filter(Boolean)
  );
  const domains = new Set(
    (customer?.domains ?? []).map(normalizeDomain).filter(Boolean)
  );
  const ownAddresses = normalizedOwnIdentityEmails(ownIdentityEmails);

  return normalizeContactCandidates(candidates).filter(candidate =>
    !ownAddresses.has(candidate.email) &&
    (addresses.has(candidate.email) || domains.has(domainFromEmail(candidate.email)))
  );
}

/**
 * Keep candidates whose address has one of the configured exact internal
 * domains. A configured domain does not include any of its subdomains.
 */
export function filterInternalContactCandidates(
  candidates,
  internalDomains,
  ownIdentityEmails = []
) {
  const domains = new Set(
    (internalDomains ?? []).map(normalizeDomain).filter(isRegistrableDomain)
  );
  const ownAddresses = normalizedOwnIdentityEmails(ownIdentityEmails);
  return normalizeContactCandidates(candidates).filter(candidate =>
    !ownAddresses.has(candidate.email) &&
    domains.has(domainFromEmail(candidate.email))
  );
}

/**
 * Parse a message once, then partition its managed contacts. Internal-domain
 * ownership takes precedence when a candidate also matches the customer rule.
 */
export async function extractManagedContactCandidates(
  header,
  customer,
  internalDomains = [],
  ownIdentityEmails = [],
  api = globalThis.messenger
) {
  const candidates = await parseMessageContactCandidates(header, api);
  const internal = filterInternalContactCandidates(
    candidates,
    internalDomains,
    ownIdentityEmails
  );
  const internalEmails = new Set(internal.map(candidate => candidate.email));
  const customerCandidates = filterCustomerContactCandidates(
    candidates,
    customer,
    ownIdentityEmails
  ).filter(candidate => !internalEmails.has(candidate.email));
  return {customer: customerCandidates, internal};
}

/** Extract customer contacts from From, To, Cc, and Bcc message headers. */
export async function extractCustomerContacts(
  header,
  customer,
  ownIdentityEmails = [],
  api = globalThis.messenger
) {
  const candidates = await parseMessageContactCandidates(header, api);
  return filterCustomerContactCandidates(candidates, customer, ownIdentityEmails);
}

export function escapeVCardText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n|\r|\n/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "")
    .replace(/\t/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\n/gu, "\\n")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,");
}

/** Create the minimal fields needed for a safe UTF-8 vCard 4.0 contact. */
export function createContactVCard(candidate, organization = "") {
  const email = normalizeEmail(candidate?.email);
  if (!email) {
    throw new TypeError("A valid contact email address is required");
  }
  const name = typeof candidate?.name === "string" && candidate.name.trim()
    ? candidate.name.trim().normalize("NFC")
    : email;
  return [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${escapeVCardText(name)}`,
    `EMAIL:${escapeVCardText(email)}`,
    `ORG:${escapeVCardText(organization)}`,
    "END:VCARD",
    ""
  ].join("\r\n");
}

function propertyValueSeparator(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ":" && !quoted) {
      return index;
    }
  }
  return -1;
}

function unescapeVCardText(value) {
  return value.replace(/\\([nN,;\\])/gu, (_match, escaped) =>
    escaped === "n" || escaped === "N" ? "\n" : escaped
  );
}

/** Return every exact normalized EMAIL property found in one or more vCards. */
export function emailsFromVCard(vCard) {
  if (typeof vCard !== "string" || !vCard) {
    return [];
  }
  const unfolded = vCard.replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/gu, "");
  const emails = [];

  for (const line of unfolded.split(/\r\n|\n|\r/gu)) {
    const separator = propertyValueSeparator(line);
    if (separator < 0) {
      continue;
    }
    const property = line
      .slice(0, separator)
      .split(";", 1)[0]
      .split(".")
      .pop()
      ?.toUpperCase();
    if (property !== "EMAIL") {
      continue;
    }
    const rawValue = unescapeVCardText(line.slice(separator + 1)).replace(
      /^mailto:/iu,
      ""
    );
    const email = normalizeEmail(rawValue);
    if (email) {
      emails.push(email);
    }
  }

  return [...new Set(emails)];
}
