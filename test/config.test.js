import test from "node:test";
import assert from "node:assert/strict";
import {normalizeConfig, validateConfig} from "../extension/lib/config.js";

const accounts = [
  {id: "work", name: "Work"},
  {id: "other", name: "Other"}
];

function baseCustomer(overrides = {}) {
  return {
    id: "acme",
    name: "Acme",
    folderName: "Acme",
    enabled: true,
    accountIds: [],
    domains: ["ACME.COM"],
    addresses: [],
    keywords: [],
    ...overrides
  };
}

test("normalization fills account defaults and sanitizes matchers", () => {
  const normalized = normalizeConfig({customers: [baseCustomer()]}, accounts);
  assert.equal(normalized.accounts.work.rootFolderName, "Customers");
  assert.equal(normalized.accounts.work.customerRootReady, false);
  assert.equal(normalized.accounts.work.archiveFolderName, "Organizer Archive");
  assert.equal(normalized.accounts.work.archiveReady, false);
  assert.equal(normalized.accounts.work.enabled, false);
  assert.deepEqual(normalized.accounts.work.internalContactDomains, []);
  assert.deepEqual(normalized.customers[0].domains, ["acme.com"]);
});

test("internal contact domains normalize without being enabled by default", () => {
  const normalized = normalizeConfig({
    accounts: {
      work: {
        internalContactDomains: [" GOOGLE.COM ", "google.com", "Sub.Google.com"]
      }
    }
  }, [{id: "work", name: "Work", identities: [{email: "ubhi@google.com"}]}]);

  assert.deepEqual(normalized.accounts.work.internalContactDomains, [
    "google.com",
    "sub.google.com"
  ]);
});

test("validation accepts only internal domains represented by current account identities", () => {
  const identityAccounts = [{
    id: "work",
    name: "Work",
    identities: [{email: "ubhi@google.com"}]
  }];
  const valid = normalizeConfig({
    accounts: {work: {internalContactDomains: ["google.com"]}}
  }, identityAccounts);
  assert.deepEqual(validateConfig(valid, identityAccounts), []);

  const unrelated = normalizeConfig({
    accounts: {work: {internalContactDomains: ["example.com"]}}
  }, identityAccounts);
  assert.ok(validateConfig(unrelated, identityAccounts).some(error =>
    error.includes("example.com does not belong to a current account identity")
  ));

  const parentInsteadOfExactIdentityDomain = normalizeConfig({
    accounts: {work: {internalContactDomains: ["google.com"]}}
  }, [{id: "work", name: "Work", identities: [{email: "ubhi@corp.google.com"}]}]);
  assert.ok(validateConfig(
    parentInsteadOfExactIdentityDomain,
    [{id: "work", name: "Work", identities: [{email: "ubhi@corp.google.com"}]}]
  ).some(error => error.includes("does not belong to a current account identity")));
});

test("validation rejects public suffixes and approvals without a current identity", () => {
  const noIdentityData = [{id: "work", name: "Work"}];
  const unverified = normalizeConfig({
    accounts: {work: {internalContactDomains: ["google.com"]}}
  }, noIdentityData);
  assert.ok(validateConfig(unverified, noIdentityData).some(error =>
    error.includes("google.com does not belong to a current account identity")
  ));

  const unsafe = normalizeConfig({
    accounts: {work: {internalContactDomains: ["co.uk"]}}
  }, noIdentityData);
  assert.ok(validateConfig(unsafe, noIdentityData).some(error =>
    error.includes("cannot be a public suffix")
  ));
});

test("validation catches a global matcher overlapping an account-specific matcher", () => {
  const normalized = normalizeConfig({
    customers: [
      baseCustomer(),
      baseCustomer({
        id: "other-customer",
        name: "Other customer",
        folderName: "Other customer",
        accountIds: ["work"]
      })
    ]
  }, accounts);
  const errors = validateConfig(normalized, accounts);
  assert.ok(errors.some(error => error.includes("domain acme.com")));
});

test("validation prevents two customers sharing a destination folder in one account", () => {
  const normalized = normalizeConfig({
    customers: [
      baseCustomer(),
      baseCustomer({
        id: "second",
        name: "Second",
        domains: ["second.example"]
      })
    ]
  }, accounts);
  const errors = validateConfig(normalized, accounts);
  assert.ok(errors.some(error => error.includes("folder Acme")));
});

test("disabled duplicate rules do not make active configuration ambiguous", () => {
  const normalized = normalizeConfig({
    customers: [baseCustomer(), baseCustomer({id: "disabled", enabled: false})]
  }, accounts);
  assert.deepEqual(validateConfig(normalized, accounts), []);
});

test("validation allows a disabled matcherless draft imported from a folder name", () => {
  const normalized = normalizeConfig({
    customers: [{
      id: "folder-draft",
      name: "Customer display name",
      folderName: "Customer display name",
      enabled: false,
      domains: [],
      addresses: [],
      keywords: [],
      accountIds: ["work"]
    }]
  }, accounts);

  assert.deepEqual(validateConfig(normalized, accounts), []);
});

test("validation rejects duplicate customer IDs", () => {
  const normalized = normalizeConfig({
    customers: [baseCustomer(), baseCustomer({name: "Duplicate", folderName: "Duplicate", domains: ["duplicate.example"]})]
  }, accounts);
  const errors = validateConfig(normalized, accounts);
  assert.ok(errors.some(error => error.includes("customer ID is duplicated")));
});

test("validation rejects unavailable account scopes instead of broadening them", () => {
  const normalized = normalizeConfig({
    customers: [baseCustomer({accountIds: ["old-work-profile"]})]
  }, accounts);
  const errors = validateConfig(normalized, accounts);
  assert.ok(errors.some(error => error.includes("old-work-profile is unavailable")));
});

test("validation allows distinct parent and sister domains while rejecting exact duplicates", () => {
  const accounts = [{id: "work"}];
  const distinctDomains = normalizeConfig({
    accounts: {work: {enabled: true}},
    customers: [
      {id: "parent", name: "Hitachi", folderName: "Hitachi", domains: ["hitachi.com"]},
      {id: "hal", name: "HAL", folderName: "HAL", domains: ["hal.hitachi.com"]},
      {id: "rail", name: "Rail", folderName: "Rail", domains: ["rail.hitachi.com"]}
    ]
  }, accounts);
  assert.deepEqual(validateConfig(distinctDomains, accounts), []);

  distinctDomains.customers.push({
    id: "duplicate",
    name: "Duplicate Rail",
    folderName: "Duplicate Rail",
    enabled: true,
    accountIds: [],
    domains: ["rail.hitachi.com"],
    addresses: [],
    keywords: []
  });
  assert.ok(validateConfig(distinctDomains, accounts).some(error =>
    /rail\.hitachi\.com is already assigned/u.test(error)
  ));
});

test("validation rejects public suffixes as customer domains", () => {
  const config = normalizeConfig({
    accounts: {work: {enabled: true}},
    customers: [{
      id: "broad",
      enabled: true,
      name: "Too broad",
      folderName: "Too broad",
      domains: ["co.uk"]
    }]
  }, accounts);
  assert.ok(validateConfig(config, accounts).some(error =>
    error.includes("public suffix")
  ));
});
