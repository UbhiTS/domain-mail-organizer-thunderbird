// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {isRegistrableDomain, normalizeDomain} from "./rules.js";

function comparableName(value) {
  return String(value ?? "").trim().normalize("NFC").toLowerCase();
}

function scopedToAccount(customer, accountId) {
  return !customer.accountIds?.length || customer.accountIds.includes(accountId);
}

/**
 * Convert direct existing child folders into conservative customer-rule
 * proposals. A domain is inferred only when the complete folder name is a
 * registrable organization domain. Other folders become disabled drafts.
 */
export function proposeCustomersFromFolders(folders, accountId, customers = []) {
  const alreadyAssigned = new Set(
    customers
      .filter(customer => scopedToAccount(customer, accountId))
      .map(customer => comparableName(customer.folderName))
      .filter(Boolean)
  );
  const proposed = [];
  const activeDomainOwners = new Map();
  for (const customer of customers) {
    if (!customer.enabled || !scopedToAccount(customer, accountId)) continue;
    for (const domain of customer.domains ?? []) {
      const normalizedDomain = normalizeDomain(domain);
      if (normalizedDomain) {
        activeDomainOwners.set(normalizedDomain, customer.name || customer.folderName);
      }
    }
  }
  for (const folder of folders ?? []) {
    const folderName = String(folder?.name ?? "").trim().normalize("NFC");
    const key = comparableName(folderName);
    if (!folderName || alreadyAssigned.has(key)) continue;
    alreadyAssigned.add(key);
    const normalizedDomain = normalizeDomain(folderName);
    const inferredDomain = normalizedDomain && isRegistrableDomain(normalizedDomain)
      ? normalizedDomain
      : null;
    const conflictingOwner = inferredDomain ? activeDomainOwners.get(inferredDomain) : null;
    proposed.push({
      name: folderName,
      folderName,
      enabled: Boolean(inferredDomain) && !conflictingOwner,
      accountIds: [accountId],
      domains: inferredDomain ? [inferredDomain] : [],
      addresses: [],
      keywords: [],
      needsReview: !inferredDomain || Boolean(conflictingOwner),
      conflictingDomain: conflictingOwner ? inferredDomain : null,
      conflictingOwner,
      warning: conflictingOwner
        ? `Domain ${inferredDomain} is already assigned to ${conflictingOwner}.`
        : inferredDomain
          ? null
          : "No domain was inferred from the folder name."
    });
    if (inferredDomain && !conflictingOwner) {
      activeDomainOwners.set(inferredDomain, folderName);
    }
  }
  return proposed;
}
