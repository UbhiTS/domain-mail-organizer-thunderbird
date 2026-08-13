// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {
  createContactVCard,
  emailsFromVCard,
  extractCustomerContacts,
  normalizeContactCandidates
} from "./contacts.js";
import {customerAppliesToAccount} from "./config.js";
import {validateManagedContactBook} from "./contact-book.js";
import {resolveCustomerFolder, resolveCustomerRoot} from "./folders.js";
import {iterateMessageList} from "./mail.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function accountId(account) {
  const id = typeof account?.id === "string" ? account.id.trim() : "";
  if (!id) throw new TypeError("A mail account ID is required.");
  return id;
}

async function emitProgress(onProgress, update) {
  try {
    await onProgress(update);
  } catch {
    // Reporting progress must never interrupt a read-only scan or contact import.
  }
}

async function assertApprovedRoot(account, accountConfig, expectedId, api) {
  if (!accountConfig?.enabled) {
    throw new Error("The selected mail account is not enabled.");
  }
  if (!accountConfig.customerRootReady) {
    throw new Error("The customer root is not approved. Run folder setup first.");
  }
  const root = await resolveCustomerRoot(account, accountConfig, false, api);
  if (!root?.id) {
    throw new Error("The approved customer root folder is missing. Run folder setup again.");
  }
  if (root.accountId && root.accountId !== account.id) {
    throw new Error("The approved customer root belongs to a different mail account.");
  }
  if (expectedId !== undefined && root.id !== expectedId) {
    throw new Error("The approved customer root changed during the scan. Start a new scan.");
  }
  return root;
}

function warning(customer, code, message) {
  return {
    code,
    customerId: customer.id,
    customerName: customer.name,
    folderName: customer.folderName,
    reason: message,
    message
  };
}

function scanProgress(result, customer, customersProcessed, customersTotal, stage) {
  return {
    phase: "scanning",
    stage,
    accountId: result.accountId,
    accountName: result.accountName,
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? "",
    folderName: customer?.folderName ?? "",
    customersProcessed,
    customersTotal,
    foldersTotal: customersTotal,
    messagesScanned: result.messagesScanned,
    foldersScanned: result.foldersScanned,
    skipped: result.skippedFolders.length
  };
}

/**
 * Read every message in each configured customer's existing direct folder and
 * extract only exact configured From/To/Cc/Bcc contacts. A customer's direct
 * folder and its descendants are included, but the customer root and unrelated
 * siblings are never scanned. This is intentionally read-only: it never reads
 * bodies, moves mail, or creates folders.
 */
export async function scanExistingCustomerContacts({
  account,
  config,
  api = globalThis.messenger,
  onProgress = async () => {}
}) {
  const id = accountId(account);
  const accountConfig = config?.accounts?.[id];
  const customerRoot = await assertApprovedRoot(account, accountConfig, undefined, api);
  const rootId = customerRoot.id;
  const customers = (config?.customers ?? []).filter(customer =>
    customerAppliesToAccount(customer, id)
  );
  const ownIdentityEmails = (account.identities ?? [])
    .map(identity => identity?.email)
    .filter(Boolean);
  const result = {
    status: "complete",
    accountId: id,
    accountName: String(account.name ?? ""),
    messagesScanned: 0,
    customersTotal: customers.length,
    customersScanned: 0,
    foldersTotal: customers.length,
    foldersScanned: 0,
    skippedFolders: [],
    contactsFound: 0,
    groups: [],
    warnings: []
  };

  await emitProgress(
    onProgress,
    scanProgress(result, null, 0, customers.length, "start")
  );

  for (let index = 0; index < customers.length; index += 1) {
    const customer = customers[index];
    await assertApprovedRoot(account, accountConfig, rootId, api);
    await emitProgress(
      onProgress,
      scanProgress(result, customer, index, customers.length, "folder-start")
    );

    let folder;
    try {
      folder = await resolveCustomerFolder(
        account,
        accountConfig,
        customer,
        false,
        api
      );
    } catch (error) {
      await assertApprovedRoot(account, accountConfig, rootId, api);
      const item = warning(
        customer,
        "folder-unavailable",
        `Could not scan folder "${customer.folderName}": ${errorMessage(error)}`
      );
      result.warnings.push(item);
      result.skippedFolders.push(item);
      result.customersScanned += 1;
      await emitProgress(onProgress, {
        ...scanProgress(result, customer, index + 1, customers.length, "folder-skipped"),
        warning: item
      });
      continue;
    }
    if (!folder) {
      const item = warning(
        customer,
        "missing-folder",
        `Customer folder "${customer.folderName}" is missing; no folder was created.`
      );
      result.warnings.push(item);
      result.skippedFolders.push(item);
      result.customersScanned += 1;
      await emitProgress(onProgress, {
        ...scanProgress(result, customer, index + 1, customers.length, "folder-skipped"),
        warning: item
      });
      continue;
    }

    // Keep one candidate per normalized address so scanning a very large
    // folder does not retain one candidate object for every message.
    const folderCandidates = new Map();
    let folderMessages = 0;
    let scanError = null;
    try {
      const firstPage = api.messages.query({
        folderId: folder.id,
        includeSubFolders: true,
        messagesPerPage: 100,
        autoPaginationTimeout: 500
      });
      for await (const message of iterateMessageList(firstPage, api)) {
        folderMessages += 1;
        result.messagesScanned += 1;
        const messageCandidates = await extractCustomerContacts(
          message,
          customer,
          ownIdentityEmails,
          api
        );
        for (const candidate of messageCandidates) {
          const existing = folderCandidates.get(candidate.email);
          if (!existing || (!existing.name && candidate.name)) {
            folderCandidates.set(candidate.email, candidate);
          }
        }
        if (result.messagesScanned % 100 === 0) {
          await emitProgress(
            onProgress,
            scanProgress(result, customer, index, customers.length, "messages")
          );
        }
      }
    } catch (error) {
      scanError = error;
    }

    await assertApprovedRoot(account, accountConfig, rootId, api);
    let currentFolder = null;
    try {
      currentFolder = await resolveCustomerFolder(
        account,
        accountConfig,
        customer,
        false,
        api
      );
    } catch (error) {
      scanError ??= error;
    }
    if (!scanError && currentFolder?.id !== folder.id) {
      scanError = new Error("The customer folder changed during the scan.");
    }

    if (scanError) {
      const item = warning(
        customer,
        "folder-scan-failed",
        `Could not completely scan folder "${customer.folderName}": ${errorMessage(scanError)}`
      );
      result.warnings.push(item);
      result.skippedFolders.push(item);
      result.customersScanned += 1;
      await emitProgress(onProgress, {
        ...scanProgress(result, customer, index + 1, customers.length, "folder-skipped"),
        warning: item
      });
      continue;
    }

    const candidates = normalizeContactCandidates([...folderCandidates.values()]);
    result.foldersScanned += 1;
    result.customersScanned += 1;
    result.contactsFound += candidates.length;
    result.groups.push({
      customerId: customer.id,
      customerName: customer.name,
      folderId: folder.id,
      folderName: folder.name,
      messagesScanned: folderMessages,
      contactsFound: candidates.length,
      candidates
    });
    await emitProgress(
      onProgress,
      scanProgress(result, customer, index + 1, customers.length, "folder-complete")
    );
  }

  await assertApprovedRoot(account, accountConfig, rootId, api);
  if (result.warnings.length) result.status = "partial";
  await emitProgress(
    onProgress,
    scanProgress(result, null, customers.length, customers.length, "complete")
  );
  return result;
}

function flattenGroups(groups) {
  const seen = new Set();
  const entries = [];
  for (const group of groups ?? []) {
    for (const candidate of normalizeContactCandidates(group?.candidates)) {
      if (seen.has(candidate.email)) continue;
      seen.add(candidate.email);
      entries.push({
        candidate,
        customerId: typeof group?.customerId === "string" ? group.customerId : "",
        customerName: typeof group?.customerName === "string" ? group.customerName : ""
      });
    }
  }
  return entries;
}

function importStatus(summary) {
  if (!summary.attempted) return "no-contacts";
  if (!summary.failed) return "complete";
  return summary.created || summary.existing ? "partial" : "failed";
}

function failedImport(entries, status, message) {
  return {
    status,
    attempted: entries.length,
    created: 0,
    existing: 0,
    failed: entries.length,
    results: entries.map(entry => ({
      email: entry.candidate.email,
      customerId: entry.customerId,
      customerName: entry.customerName,
      status: "failed",
      error: message
    })),
    errors: [message]
  };
}

/**
 * Import a completed scan into an already-owned managed address book. The
 * first group containing an email deterministically owns its ORG value. No
 * book is created/adopted and no existing contact is updated or deleted.
 */
export async function importExistingCustomerContacts({
  account,
  storedBook,
  groups,
  api = globalThis.messenger,
  onProgress = async () => {}
}) {
  accountId(account);
  const entries = flattenGroups(groups);
  let books;
  let managed;
  try {
    managed = await validateManagedContactBook(
      account,
      storedBook,
      {
        addressBooks: {
          list: async () => {
            books = await api.addressBooks.list();
            return books;
          }
        }
      }
    );
  } catch (error) {
    return failedImport(entries, "unavailable", errorMessage(error));
  }

  const existingEmails = new Set();
  try {
    for (const book of books ?? []) {
      const contacts = await api.addressBooks.contacts.list(book.id);
      for (const contact of contacts ?? []) {
        for (const email of emailsFromVCard(contact?.vCard)) {
          existingEmails.add(email);
        }
      }
    }
  } catch (error) {
    return failedImport(
      entries,
      "failed",
      `Could not check all address books for duplicates: ${errorMessage(error)}`
    );
  }

  const summary = {
    status: "complete",
    attempted: entries.length,
    created: 0,
    existing: 0,
    failed: 0,
    results: [],
    errors: []
  };
  await emitProgress(onProgress, {
    phase: "importing",
    stage: "start",
    attempted: summary.attempted,
    processed: 0,
    created: 0,
    existing: 0,
    failed: 0
  });

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const row = {
      email: entry.candidate.email,
      customerId: entry.customerId,
      customerName: entry.customerName
    };
    if (existingEmails.has(entry.candidate.email)) {
      summary.existing += 1;
      summary.results.push({...row, status: "existing"});
    } else {
      try {
        const contactId = await api.addressBooks.contacts.create(
          managed.addressBookId,
          createContactVCard(entry.candidate, entry.customerName)
        );
        existingEmails.add(entry.candidate.email);
        summary.created += 1;
        summary.results.push({...row, status: "created", contactId});
      } catch (error) {
        const message = errorMessage(error);
        summary.failed += 1;
        summary.results.push({...row, status: "failed", error: message});
        summary.errors.push(`${entry.candidate.email}: ${message}`);
      }
    }

    const processed = index + 1;
    if (processed % 100 === 0 || processed === entries.length) {
      await emitProgress(onProgress, {
        phase: "importing",
        stage: processed === entries.length ? "complete" : "contacts",
        attempted: summary.attempted,
        processed,
        created: summary.created,
        existing: summary.existing,
        failed: summary.failed,
        customerId: entry.customerId,
        customerName: entry.customerName
      });
    }
  }

  summary.status = importStatus(summary);
  summary.errors = [...new Set(summary.errors)];
  return summary;
}
