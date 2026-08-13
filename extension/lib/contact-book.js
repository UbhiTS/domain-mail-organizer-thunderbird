// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  approvedInternalDomains,
  createContactVCard,
  emailsFromVCard,
  extractManagedContactCandidates,
  normalizeContactCandidates
} from "./contacts.js";
import {customerById} from "./config.js";
import {domainFromEmail} from "./rules.js";

export const MANAGED_CONTACT_BOOK_PREFIX = "Customer Contacts — ";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function comparableName(value) {
  return String(value ?? "").trim().normalize("NFC").toLocaleLowerCase();
}

function accountId(account) {
  const id = typeof account?.id === "string" ? account.id.trim() : "";
  if (!id) {
    throw new TypeError("A mail account ID is required");
  }
  return id;
}

export function managedContactBookName(account) {
  const id = accountId(account);
  const name = typeof account?.name === "string"
    ? account.name.trim().normalize("NFC")
    : "";
  if (!name) {
    throw new TypeError("A mail account name is required");
  }
  const identityEmail = normalizeContactCandidates(
    (account.identities ?? []).map(identity => ({email: identity?.email}))
  )[0]?.email;
  const suffix = encodeURIComponent(id);
  return `${MANAGED_CONTACT_BOOK_PREFIX}${identityEmail || name} (${suffix})`;
}

function validateManagedBook(book, expectedName) {
  if (!book || typeof book.id !== "string" || !book.id) {
    throw new Error("The managed customer address book is missing.");
  }
  if (book.type && book.type !== "addressBook") {
    throw new Error("The stored customer contact destination is not an address book.");
  }
  if (comparableName(book.name) !== comparableName(expectedName)) {
    throw new Error(
      `The managed customer address book was renamed. Expected “${expectedName}”.`
    );
  }
  if (book.remote) {
    throw new Error("The managed customer address book must be local.");
  }
  if (book.readOnly) {
    throw new Error("The managed customer address book is read-only.");
  }
  return book;
}

function sameNamedBooks(books, expectedName, exceptId = null) {
  const expected = comparableName(expectedName);
  return books.filter(book =>
    book?.id !== exceptId && comparableName(book?.name) === expected
  );
}

function managedBookReference(account, storedBook) {
  if (typeof storedBook === "string") {
    return {
      addressBookId: storedBook,
      addressBookName: managedContactBookName(account)
    };
  }
  return {
    addressBookId: typeof storedBook?.addressBookId === "string"
      ? storedBook.addressBookId
      : "",
    addressBookName:
      typeof storedBook?.addressBookName === "string" && storedBook.addressBookName
        ? storedBook.addressBookName.normalize("NFC")
        : managedContactBookName(account)
  };
}

/** Validate a previously stored managed-book ID without creating or adopting. */
export async function validateManagedContactBook(
  account,
  storedBook,
  api = globalThis.messenger
) {
  const id = accountId(account);
  const reference = managedBookReference(account, storedBook);
  const expectedName = reference.addressBookName;
  if (!reference.addressBookId) {
    throw new Error("The managed customer address book has not been set up.");
  }
  const books = await api.addressBooks.list();
  const book = books.find(candidate => candidate?.id === reference.addressBookId);
  validateManagedBook(book, expectedName);
  if (sameNamedBooks(books, expectedName, book.id).length) {
    throw new Error(
      `Another address book named “${expectedName}” already exists and is not managed by this extension.`
    );
  }
  return {
    accountId: id,
    addressBookId: book.id,
    addressBookName: expectedName
  };
}

/**
 * Explicitly set up one extension-owned local address book for a mail account.
 * Existing same-name books are never adopted implicitly.
 */
export async function setupManagedContactBook(
  account,
  storedBook = null,
  api = globalThis.messenger
) {
  const id = accountId(account);
  const reference = managedBookReference(account, storedBook);
  const expectedName = reference.addressBookName;
  const books = await api.addressBooks.list();
  const normalizedStoredId = reference.addressBookId || null;
  const existingStoredBook = normalizedStoredId
    ? books.find(book => book?.id === normalizedStoredId) ?? null
    : null;

  if (existingStoredBook) {
    validateManagedBook(existingStoredBook, expectedName);
    if (sameNamedBooks(books, expectedName, existingStoredBook.id).length) {
      throw new Error(
        `Another address book named “${expectedName}” already exists and is not managed by this extension.`
      );
    }
    return {
      accountId: id,
      addressBookId: existingStoredBook.id,
      addressBookName: expectedName,
      created: false
    };
  }

  if (sameNamedBooks(books, expectedName).length) {
    throw new Error(
      `An address book named “${expectedName}” already exists and is not managed by this extension.`
    );
  }

  const createdId = await api.addressBooks.create({name: expectedName});
  if (typeof createdId !== "string" || !createdId) {
    throw new Error("Thunderbird did not return an ID for the new customer address book.");
  }
  return {
    accountId: id,
    addressBookId: createdId,
    addressBookName: expectedName,
    created: true
  };
}

function failedImport(candidates, status, message) {
  return {
    status,
    attempted: candidates.length,
    created: 0,
    existing: 0,
    failed: candidates.length,
    results: candidates.map(candidate => ({
      email: candidate.email,
      status: "failed",
      error: message
    }))
  };
}

function completedStatus({attempted, created, existing, failed}) {
  if (!attempted) return "no-contacts";
  if (!failed) return "complete";
  return created || existing ? "partial" : "failed";
}

function normalizedManagedContactGroups(groups) {
  const rows = [];
  const indexes = new Map();
  for (const group of groups ?? []) {
    const organization = typeof group?.organization === "string"
      ? group.organization.trim().normalize("NFC")
      : "";
    for (const candidate of normalizeContactCandidates(group?.candidates)) {
      const existingIndex = indexes.get(candidate.email);
      if (existingIndex === undefined) {
        indexes.set(candidate.email, rows.length);
        rows.push({candidate, organization});
      } else if (!rows[existingIndex].candidate.name && candidate.name) {
        rows[existingIndex] = {
          ...rows[existingIndex],
          candidate
        };
      }
    }
  }
  return rows;
}

/**
 * Import multiple organization groups with one validation and one global
 * address-book inventory. An email in more than one group belongs to the first
 * group, allowing callers to put higher-priority groups first.
 */
export async function importManagedContactGroups(
  account,
  storedBook,
  groups,
  api = globalThis.messenger
) {
  const rows = normalizedManagedContactGroups(groups);
  const normalized = rows.map(row => row.candidate);
  if (!rows.length) {
    return {
      status: "no-contacts",
      attempted: 0,
      created: 0,
      existing: 0,
      failed: 0,
      results: []
    };
  }

  let expectedName;
  let reference;
  try {
    reference = managedBookReference(account, storedBook);
    expectedName = reference.addressBookName;
  } catch (error) {
    return failedImport(normalized, "unavailable", errorMessage(error));
  }
  if (!reference.addressBookId) {
    return failedImport(
      normalized,
      "unavailable",
      "The managed customer address book has not been set up."
    );
  }

  let books;
  try {
    books = await api.addressBooks.list();
  } catch (error) {
    return failedImport(normalized, "failed", errorMessage(error));
  }
  const target = books.find(book => book?.id === reference.addressBookId);
  try {
    validateManagedBook(target, expectedName);
  } catch (error) {
    return failedImport(normalized, "unavailable", errorMessage(error));
  }

  const existingEmails = new Set();
  try {
    for (const book of books) {
      const contacts = await api.addressBooks.contacts.list(book.id);
      for (const contact of contacts ?? []) {
        for (const email of emailsFromVCard(contact?.vCard)) {
          existingEmails.add(email);
        }
      }
    }
  } catch (error) {
    return failedImport(
      normalized,
      "failed",
      `Could not check all address books for duplicates: ${errorMessage(error)}`
    );
  }

  const summary = {
    status: "complete",
    attempted: normalized.length,
    created: 0,
    existing: 0,
    failed: 0,
    results: []
  };
  for (const {candidate, organization} of rows) {
    if (existingEmails.has(candidate.email)) {
      summary.existing += 1;
      summary.results.push({email: candidate.email, status: "existing"});
      continue;
    }
    try {
      const contactId = await api.addressBooks.contacts.create(
        target.id,
        createContactVCard(candidate, organization)
      );
      existingEmails.add(candidate.email);
      summary.created += 1;
      summary.results.push({
        email: candidate.email,
        status: "created",
        contactId
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        email: candidate.email,
        status: "failed",
        error: errorMessage(error)
      });
    }
  }
  summary.status = completedStatus(summary);
  return summary;
}

/**
 * Import candidates into an already-owned managed address book. This function
 * never creates or adopts an address book. Email deduplication is global across
 * every address book in the current Thunderbird profile.
 */
export async function importManagedContacts(
  account,
  storedBook,
  candidates,
  organization = "",
  api = globalThis.messenger
) {
  return importManagedContactGroups(
    account,
    storedBook,
    [{organization, candidates}],
    api
  );
}

/**
 * Extract and import contacts only from messages whose automatic customer move
 * completed. Exact internal-domain groups take precedence, while remaining
 * candidates stay grouped by the customer that owned the move.
 */
export async function captureMovedMessageContacts({
  account,
  storedBook,
  config,
  completed,
  api = globalThis.messenger
}) {
  const ownIdentityEmails = (account?.identities ?? [])
    .map(identity => identity?.email)
    .filter(Boolean);
  const internalDomains = approvedInternalDomains(
    account?.identities,
    config?.accounts?.[account?.id]?.internalContactDomains
  );
  const byInternalDomain = new Map();
  const byCustomer = new Map();
  for (const entry of completed ?? []) {
    const customer = customerById(config, entry?.item?.customerId);
    if (!customer || !entry?.message) continue;
    const candidates = await extractManagedContactCandidates(
      entry.message,
      customer,
      internalDomains,
      ownIdentityEmails,
      api
    );
    for (const candidate of candidates.internal) {
      const domain = domainFromEmail(candidate.email);
      if (!domain) continue;
      if (!byInternalDomain.has(domain)) {
        byInternalDomain.set(domain, []);
      }
      byInternalDomain.get(domain).push(candidate);
    }
    if (!byCustomer.has(customer.id)) {
      byCustomer.set(customer.id, {customer, candidates: []});
    }
    byCustomer.get(customer.id).candidates.push(...candidates.customer);
  }

  const groups = [
    ...[...byInternalDomain].map(([domain, candidates]) => ({
      organization: domain,
      candidates
    })),
    ...[...byCustomer.values()].map(({customer, candidates}) => ({
      organization: customer.name,
      candidates
    }))
  ];
  const result = await importManagedContactGroups(
    account,
    storedBook,
    groups,
    api
  );
  const summary = {
    attempted: result.attempted,
    created: result.created,
    existing: result.existing,
    failed: result.failed
  };
  const errors = (result.results ?? [])
    .filter(row => row.status === "failed" && row.error)
    .map(row => row.error);
  if (errors.length) {
    summary.error = [...new Set(errors)].slice(0, 3).join("; ");
  }
  return summary;
}
