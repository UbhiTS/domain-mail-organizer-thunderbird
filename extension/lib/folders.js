// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {validateFolderName} from "./rules.js";

export function folderSpecialUses(folder) {
  if (Array.isArray(folder?.specialUse)) {
    return folder.specialUse;
  }
  return folder?.type ? [folder.type] : [];
}

export function folderHasSpecialUse(folder, specialUse) {
  return folderSpecialUses(folder).includes(specialUse);
}

export function flattenFolders(folder) {
  if (!folder) {
    return [];
  }
  const result = [folder];
  for (const child of folder.subFolders ?? []) {
    result.push(...flattenFolders(child));
  }
  return result;
}

export function findSpecialFolder(account, specialUse) {
  return flattenFolders(account?.rootFolder).find(folder =>
    folderHasSpecialUse(folder, specialUse)
  ) ?? null;
}

export async function listAccounts(api = messenger) {
  const accounts = await api.accounts.list(true);
  return accounts.filter(account => ["imap", "pop3", "ews"].includes(account.type));
}

export async function getAccount(accountId, api = messenger) {
  const account = await api.accounts.get(accountId, true);
  if (!account) {
    throw new Error("The selected mail account is no longer available.");
  }
  return account;
}

function sameFolderName(left, right) {
  return left.normalize("NFC").toLocaleLowerCase() === right.normalize("NFC").toLocaleLowerCase();
}

function directFolderIndex(folders) {
  const byName = new Map();
  for (const folder of folders) {
    const name = String(folder?.name ?? "").normalize("NFC");
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (byName.has(key)) {
      throw new Error(
        `More than one direct folder matches “${name}”. Rename the duplicate folders before continuing.`
      );
    }
    byName.set(key, folder);
  }
  return byName;
}

function folderCannotBeOrganizerDestination(folder) {
  return Boolean(
    folderSpecialUses(folder).length ||
    folder?.isVirtual ||
    folder?.isUnified ||
    folder?.isTag
  );
}

export async function directSubfolders(parent, api = messenger) {
  return api.folders.getSubFolders(parent.id, false);
}

export async function findDirectChild(parent, childName, api = messenger) {
  const children = await directSubfolders(parent, api);
  const matches = children.filter(child => sameFolderName(child.name ?? "", childName));
  if (matches.length > 1) {
    throw new Error(
      `More than one direct folder matches “${childName}”. Rename the duplicate folders before continuing.`
    );
  }
  const [child] = matches;
  if (
    child?.accountId &&
    parent?.accountId &&
    child.accountId !== parent.accountId
  ) {
    throw new Error(`Folder “${childName}” belongs to a different account.`);
  }
  return child ?? null;
}

async function ensureChild(
  parent,
  childName,
  create,
  api = messenger,
  allowExisting = true
) {
  const nameError = validateFolderName(childName);
  if (nameError) {
    throw new Error(nameError);
  }

  let child = await findDirectChild(parent, childName, api);
  if (child && folderCannotBeOrganizerDestination(child)) {
    throw new Error(`Folder “${childName}” is a special-use folder and cannot be reused.`);
  }
  if (child || !create) {
    if (child && !allowExisting) {
      throw new Error(
        `Folder “${childName}” already exists but is not the destination selected by this plan. Run setup and create a new preview.`
      );
    }
    return child;
  }

  const capabilities = await api.folders.getFolderCapabilities(parent.id);
  if (capabilities?.canAddSubfolders === false) {
    throw new Error(`Folder “${parent.name}” cannot contain customer folders.`);
  }

  try {
    child = await api.folders.create(parent.id, childName);
  } catch (error) {
    if (!allowExisting) {
      throw error;
    }
    // An IMAP refresh or a competing setup can win the create race. Re-resolve
    // and only reuse the exact sibling we intended to create.
    child = await findDirectChild(parent, childName, api);
    if (!child) throw error;
  }
  return child;
}

async function createChildStrict(parent, childName, api = messenger) {
  const nameError = validateFolderName(childName);
  if (nameError) {
    throw new Error(nameError);
  }
  const capabilities = await api.folders.getFolderCapabilities(parent.id);
  if (capabilities?.canAddSubfolders === false) {
    throw new Error(`Folder “${parent.name}” cannot contain organizer folders.`);
  }
  const child = await api.folders.create(parent.id, childName);
  if (folderCannotBeOrganizerDestination(child)) {
    throw new Error(`Folder “${childName}” became a special-use folder and cannot be reused.`);
  }
  return child;
}

export async function resolveCustomerRoot(account, accountConfig, create, api = messenger) {
  const root = account.rootFolder;
  if (!root?.id) {
    throw new Error(`Account “${account.name}” has no usable root folder.`);
  }
  const existing = await findDirectChild(root, accountConfig.rootFolderName, api);
  if (existing && folderCannotBeOrganizerDestination(existing)) {
    throw new Error(
      `Folder “${accountConfig.rootFolderName}” is now a special-use folder and cannot be the domain root.`
    );
  }
  if (!accountConfig.customerRootReady) {
    if (!create) {
      return null;
    }
    if (existing) {
      throw new Error(
        `Folder “${accountConfig.rootFolderName}” already exists but has not been verified. Choose Save & set up first.`
      );
    }
    const created = await createChildStrict(root, accountConfig.rootFolderName, api);
    accountConfig.customerRootReady = true;
    return created;
  }
  return existing ?? ensureChild(root, accountConfig.rootFolderName, create, api);
}

export async function resolveOrganizerArchive(
  account,
  accountConfig,
  create,
  api = messenger,
  requireNew = false
) {
  const root = account.rootFolder;
  if (!root?.id) {
    throw new Error(`Account “${account.name}” has no usable root folder.`);
  }
  const existing = await findDirectChild(root, accountConfig.archiveFolderName, api);
  if (existing && folderCannotBeOrganizerDestination(existing)) {
    throw new Error(
      `Folder “${accountConfig.archiveFolderName}” is now a special-use folder and cannot be the configured archive.`
    );
  }
  if (!accountConfig.archiveReady && !requireNew) {
    return null;
  }
  if (requireNew && existing) {
    throw new Error(
      `Folder “${accountConfig.archiveFolderName}” already exists. Choose Save & set up to verify that archive slot.`
    );
  }
  const archive = existing ?? (
    create
      ? await createChildStrict(root, accountConfig.archiveFolderName, api)
      : null
  );
  if (!archive) {
    return null;
  }
  const capabilities = await api.folders.getFolderCapabilities(archive.id);
  if (capabilities?.canAddMessages === false) {
    throw new Error(`Folder “${archive.name}” cannot receive messages.`);
  }
  return archive;
}

export async function resolveCustomerFolder(
  account,
  accountConfig,
  customer,
  create,
  api = messenger,
  expectedExistingFolderId = null,
  expectedRootFolderId = undefined,
  expectedMissing = false
) {
  let root = await resolveCustomerRoot(account, accountConfig, false, api);
  if (expectedRootFolderId !== undefined) {
    const rootChanged = expectedRootFolderId === null
      ? Boolean(root)
      : !root || root.id !== expectedRootFolderId;
    if (rootChanged) {
      throw new Error(
        `The domain root changed after preview. Create a fresh preview before applying.`
      );
    }
  }
  if (!root && expectedExistingFolderId) {
    throw new Error(
      `The domain root changed after preview. Create a fresh preview before applying.`
    );
  }
  if (!root && create) {
    if (expectedRootFolderId === null) {
      root = await createChildStrict(account.rootFolder, accountConfig.rootFolderName, api);
      accountConfig.customerRootReady = true;
    } else {
      root = await resolveCustomerRoot(account, accountConfig, true, api);
    }
  }
  if (!root) {
    if (expectedExistingFolderId) {
      throw new Error(
        `The domain root changed after preview. Create a fresh preview before applying.`
      );
    }
    return null;
  }
  let existing = null;
  const rootExistedAtPreview = expectedRootFolderId !== null;
  if (expectedExistingFolderId || (expectedMissing && rootExistedAtPreview)) {
    existing = await findDirectChild(root, customer.folderName, api);
  }
  if (expectedExistingFolderId) {
    if (!existing || existing.id !== expectedExistingFolderId) {
      throw new Error(
        `Folder “${customer.folderName}” changed after preview. Create a fresh preview before applying.`
      );
    }
  }
  if (expectedMissing && rootExistedAtPreview && existing) {
    throw new Error(
      `Folder “${customer.folderName}” appeared after preview. Create a fresh preview before applying.`
    );
  }
  const customerFolder = expectedExistingFolderId
    ? existing
    : expectedMissing && create
      ? await createChildStrict(root, customer.folderName, api)
      : await ensureChild(root, customer.folderName, create, api);
  if (!customerFolder) {
    return null;
  }
  if (folderCannotBeOrganizerDestination(customerFolder)) {
    throw new Error(
      `Folder “${customer.folderName}” is now a special-use folder and cannot receive organized mail.`
    );
  }

  const capabilities = await api.folders.getFolderCapabilities(customerFolder.id);
  if (capabilities?.canAddMessages === false) {
    throw new Error(`Folder “${customerFolder.name}” cannot receive messages.`);
  }
  return customerFolder;
}

export async function discoverCustomerFolders(account, accountConfig, api = messenger) {
  const root = await resolveCustomerRoot(account, accountConfig, false, api);
  if (!root) {
    return [];
  }
  return directSubfolders(root, api);
}

/**
 * Read-only discovery for an existing domain root. Only direct normal child
 * folders are returned; no folder is created or marked ready.
 */
export async function discoverExistingCustomerFolders(
  account,
  rootFolderName,
  api = messenger
) {
  const rootNameError = validateFolderName(rootFolderName);
  if (rootNameError) throw new Error(rootNameError);
  const existingRoot = await findDirectChild(account.rootFolder, rootFolderName, api);
  if (!existingRoot) {
    throw new Error(`No existing folder named “${rootFolderName}” was found.`);
  }
  if (folderCannotBeOrganizerDestination(existingRoot)) {
    throw new Error(`Folder “${rootFolderName}” is special-use and cannot be a domain root.`);
  }
  const rootCapabilities = await api.folders.getFolderCapabilities(existingRoot.id);
  if (rootCapabilities?.canAddSubfolders === false) {
    throw new Error(`Folder “${rootFolderName}” cannot contain customer folders.`);
  }
  const children = await directSubfolders(existingRoot, api);
  directFolderIndex(children);
  const folders = [];
  for (const folder of children) {
    if (!folder?.name || folderCannotBeOrganizerDestination(folder)) continue;
    if (
      folder.accountId &&
      existingRoot.accountId &&
      folder.accountId !== existingRoot.accountId
    ) {
      throw new Error(`Folder “${folder.name}” belongs to a different account.`);
    }
    const capabilities = await api.folders.getFolderCapabilities(folder.id);
    if (capabilities?.canAddMessages === false) continue;
    folders.push({name: folder.name});
  }
  return {
    accountId: account.id,
    accountName: account.name,
    rootFolderName: existingRoot.name,
    folders
  };
}

export async function setupAllCustomerFolders(
  config,
  accounts,
  api = messenger
) {
  const createdOrFound = [];
  const errors = [];

  for (const account of accounts) {
    const accountConfig = config.accounts?.[account.id];
    if (!accountConfig?.enabled) {
      continue;
    }
    // Readiness is proven anew by this setup run. Never preserve a stale
    // readiness marker after a failed folder validation.
    accountConfig.archiveReady = false;
    accountConfig.customerRootReady = false;
    try {
      const archiveFolder = await ensureChild(
        account.rootFolder,
        accountConfig.archiveFolderName,
        true,
        api,
        true
      );
      const archiveCapabilities = await api.folders.getFolderCapabilities(archiveFolder.id);
      if (archiveCapabilities?.canAddMessages === false) {
        throw new Error(`Folder “${accountConfig.archiveFolderName}” cannot receive messages.`);
      }
      accountConfig.archiveReady = true;
      createdOrFound.push({
        accountId: account.id,
        accountName: account.name,
        customerId: null,
        customerName: accountConfig.archiveFolderName,
        folderName: archiveFolder.name
      });
    } catch (error) {
      errors.push(`${account.name} / ${accountConfig.archiveFolderName}: ${error.message}`);
    }
    let customerRoot = null;
    try {
      const existingRoot = await findDirectChild(
        account.rootFolder,
        accountConfig.rootFolderName,
        api
      );
      if (existingRoot && folderCannotBeOrganizerDestination(existingRoot)) {
        throw new Error(`Folder “${accountConfig.rootFolderName}” is special-use and cannot be used.`);
      }
      customerRoot = existingRoot;
      if (customerRoot) {
        const capabilities = await api.folders.getFolderCapabilities(customerRoot.id);
        if (capabilities?.canAddSubfolders === false) {
          throw new Error(`Folder “${accountConfig.rootFolderName}” cannot contain customer folders.`);
        }
      }
      if (!customerRoot) {
        customerRoot = await ensureChild(
          account.rootFolder,
          accountConfig.rootFolderName,
          true,
          api,
          true
        );
      }
      const rootCapabilities = await api.folders.getFolderCapabilities(customerRoot.id);
      if (rootCapabilities?.canAddSubfolders === false) {
        throw new Error(`Folder “${accountConfig.rootFolderName}” cannot contain domain folders.`);
      }
      accountConfig.customerRootReady = true;
    } catch (error) {
      errors.push(`${account.name} / ${accountConfig.rootFolderName}: ${error.message}`);
      continue;
    }
    let existingByName;
    try {
      const existingCustomerFolders = await directSubfolders(customerRoot, api);
      existingByName = directFolderIndex(existingCustomerFolders);
    } catch (error) {
      errors.push(`${account.name} / ${accountConfig.rootFolderName}: ${error.message}`);
      continue;
    }

    for (const customer of config.customers) {
      if (
        !customer.enabled ||
        (customer.accountIds.length && !customer.accountIds.includes(account.id))
      ) {
        continue;
      }
      try {
        const normalizedName = customer.folderName.normalize("NFC").toLocaleLowerCase();
        const existing = existingByName.get(normalizedName);
        let folder;
        if (existing) {
          if (folderCannotBeOrganizerDestination(existing)) {
            throw new Error(`Folder “${customer.folderName}” is special-use and cannot be reused.`);
          }
          const capabilities = await api.folders.getFolderCapabilities(existing.id);
          if (capabilities?.canAddMessages === false) {
            throw new Error(`Folder “${customer.folderName}” cannot receive messages.`);
          }
          folder = existing;
        } else {
          folder = await ensureChild(
            customerRoot,
            customer.folderName,
            true,
            api,
            true
          );
          existingByName.set(normalizedName, folder);
        }
        createdOrFound.push({
          accountId: account.id,
          accountName: account.name,
          customerId: customer.id,
          customerName: customer.name,
          folderName: folder.name
        });
      } catch (error) {
        errors.push(`${account.name} / ${customer.name}: ${error.message}`);
      }
    }
  }

  return {folders: createdOrFound, errors};
}

export async function folderIsInside(folder, ancestor, api = messenger) {
  if (!folder?.id || !ancestor?.id || folder.accountId !== ancestor.accountId) {
    return false;
  }
  if (folder.id === ancestor.id) {
    return true;
  }
  const parents = await api.folders.getParentFolders(folder.id, false);
  return parents.some(parent => parent.id === ancestor.id);
}

export async function folderOrAncestorHasSpecialUse(folder, specialUses, api = messenger) {
  if (!folder?.id) {
    return false;
  }
  if (folderSpecialUses(folder).some(type => specialUses.has(type))) {
    return true;
  }
  const parents = await api.folders.getParentFolders(folder.id, false);
  return parents.some(parent =>
    folderSpecialUses(parent).some(type => specialUses.has(type))
  );
}
