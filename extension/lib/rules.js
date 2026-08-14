// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {parse as parsePublicSuffix} from "../vendor/psl.mjs";
import {customersByName} from "./sort.js";

function safeHostname(value) {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return "";
  }
}

export function normalizeDomain(value) {
  if (typeof value !== "string") {
    return "";
  }

  let candidate = value.trim().toLowerCase();
  if (candidate.startsWith("@")) {
    candidate = candidate.slice(1);
  }
  candidate = candidate.replace(/\.+$/, "");

  if (!candidate || candidate.includes("@") || /[\s/\\]/u.test(candidate)) {
    return "";
  }

  const hostname = safeHostname(candidate).replace(/\.+$/, "").toLowerCase();
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) {
    return "";
  }

  const valid = hostname.split(".").every(label =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
  return valid ? hostname : "";
}

export function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  const candidate = value.trim().toLowerCase();
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1 || /\s/u.test(candidate)) {
    return "";
  }
  const local = candidate.slice(0, at);
  const domain = normalizeDomain(candidate.slice(at + 1));
  return local && !local.includes("@") && domain ? `${local}@${domain}` : "";
}

export function domainFromEmail(value) {
  const email = normalizeEmail(value);
  return email ? email.slice(email.lastIndexOf("@") + 1) : "";
}

export function isRegistrableDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain) return false;
  const parsed = parsePublicSuffix(domain);
  return Boolean(parsed?.listed && parsed.domain);
}

export function validateFolderName(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "folder name cannot be empty.";
  }
  const normalized = value.trim().normalize("NFC");
  if (/[\u0000-\u001f\u007f/\\]/u.test(normalized)) {
    return "folder name cannot contain slashes or control characters.";
  }
  if ([...normalized].length > 80) {
    return "folder name must be 80 characters or fewer.";
  }
  return "";
}

function customerInScope(customer, accountId) {
  return (
    customer.enabled !== false &&
    customer.domains.every(isRegistrableDomain) &&
    (!customer.accountIds?.length || customer.accountIds.includes(accountId))
  );
}

function matchEmails(emails, customers) {
  const candidates = (emails ?? [])
    .map(email => normalizeEmail(email))
    .filter(Boolean)
    .map(email => ({email, domain: domainFromEmail(email)}));

  // Exact addresses are more specific than domains. Customer Rules order is
  // the stable tie-breaker among matches with the same specificity.
  const addressMatches = [];
  for (const customer of customers) {
    for (const {email} of candidates) {
      if (customer.addresses.includes(email)) {
        addressMatches.push({customer, value: email, matcher: "address"});
        break;
      }
    }
  }
  if (addressMatches.length) {
    return addressMatches;
  }

  const domainMatches = [];
  for (const customer of customers) {
    for (const {domain} of candidates) {
      if (customer.domains.includes(domain)) {
        domainMatches.push({customer, value: domain, matcher: "domain"});
        break;
      }
    }
  }
  return domainMatches;
}

function hostnameCandidates(text) {
  const candidates = [];
  const domainLike = /(?:[a-z0-9](?:[a-z0-9-]{0,62})?\.)+[a-z0-9](?:[a-z0-9-]{0,62})?\.?/giu;
  for (const match of text.matchAll(domainLike)) {
    const normalized = normalizeDomain(match[0]);
    if (normalized) {
      candidates.push(normalized);
    }
  }
  return [...new Set(candidates)];
}

function matchText(text, customers) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  const normalizedText = text.toLowerCase();
  const domains = new Set(hostnameCandidates(normalizedText));
  const domainMatches = [];
  for (const customer of customers) {
    const domain = customer.domains.find(candidate => domains.has(candidate));
    if (domain) {
      domainMatches.push({customer, value: domain, matcher: "domain"});
    }
  }
  if (domainMatches.length) {
    return domainMatches;
  }

  const keywordMatches = [];
  for (const customer of customers) {
    for (const keyword of customer.keywords) {
      if (keyword && normalizedText.includes(keyword)) {
        keywordMatches.push({customer, value: keyword, matcher: "keyword"});
        break;
      }
    }
  }
  return keywordMatches;
}

function stageResult(matches, stage) {
  if (!matches.length) {
    return null;
  }
  const [match] = matches;
  return {
    status: "matched",
    stage,
    customerId: match.customer.id,
    reason: `${stage} ${match.matcher} matched ${match.value}`
  };
}

/**
 * Preserve the Outlook add-in's precedence and select the first deterministic
 * match in each stage: sender, To/Cc recipient, subject, then body.
 */
export function classifyMessage(message, config, accountId) {
  const customers = customersByName(config.customers ?? []).filter(customer =>
    customerInScope(customer, accountId)
  );

  if (!customers.length) {
    return {status: "unmatched", reason: "No enabled customer rules for this account"};
  }

  const stages = [
    [
      "address",
      matchEmails(
        [...(message.authorEmails ?? []), ...(message.recipientEmails ?? [])],
        customers
      )
    ]
  ];
  if (config.scanSubject !== false) {
    stages.push(["subject", matchText(message.subject, customers)]);
  }
  if (config.scanBody !== false && typeof message.body === "string") {
    stages.push(["body", matchText(message.body, customers)]);
  }

  for (const [stage, matches] of stages) {
    const result = stageResult(matches, stage);
    if (result) {
      return result;
    }
  }

  return {status: "unmatched", reason: "No domain, address, or keyword matched"};
}

export function fallbackParseMailboxString(value) {
  if (typeof value !== "string") {
    return [];
  }
  const matches = value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/giu) ?? [];
  return [...new Set(matches.map(normalizeEmail).filter(Boolean))];
}
