// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {isRegistrableDomain, normalizeDomain, normalizeEmail} from "../lib/rules.js";
import {customersByName} from "../lib/sort.js";

const elements = {
  status: document.querySelector("#status"),
  accounts: document.querySelector("#accounts"),
  customers: document.querySelector("#customers"),
  accountTemplate: document.querySelector("#accountTemplate"),
  customerTemplate: document.querySelector("#customerTemplate"),
  defaultDays: document.querySelector("#defaultDays"),
  maxMessages: document.querySelector("#maxMessages"),
  scanSubject: document.querySelector("#scanSubject"),
  scanBody: document.querySelector("#scanBody"),
  preserveFlagged: document.querySelector("#preserveFlagged"),
  addCustomer: document.querySelector("#addCustomer"),
  save: document.querySelector("#save"),
  setupFolders: document.querySelector("#setupFolders"),
  buildAddressBooks: document.querySelector("#buildAddressBooks"),
  mailAccountsPanel: document.querySelector("#mailAccountsPanel"),
  export: document.querySelector("#export"),
  import: document.querySelector("#import"),
  importFile: document.querySelector("#importFile"),
  folderImportDialog: document.querySelector("#folderImportDialog"),
  folderImportDescription: document.querySelector("#folderImportDescription"),
  folderImportStatus: document.querySelector("#folderImportStatus"),
  folderImportList: document.querySelector("#folderImportList"),
  folderImportTemplate: document.querySelector("#folderImportTemplate"),
  cancelFolderImportTop: document.querySelector("#cancelFolderImportTop"),
  cancelFolderImport: document.querySelector("#cancelFolderImport"),
  addFolderImports: document.querySelector("#addFolderImports")
};

let bootstrap;
let config;
let folderImportContext = null;
let contactBackfillRunning = false;
let contactBackfillProgress = null;

function send(command, extra = {}) {
  return messenger.runtime.sendMessage({dmo: true, command, ...extra});
}

function uid() {
  return crypto.randomUUID?.() ?? `customer-${Date.now()}-${Math.random()}`;
}

function splitList(value) {
  return [...new Set(value.split(/[,\n]/u).map(entry => entry.trim()).filter(Boolean))];
}

function showStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.className = `banner ${error ? "error" : "success"}`;
  elements.status.classList.remove("hidden");
  if (error) {
    elements.status.scrollIntoView({behavior: "smooth", block: "nearest"});
  }
}

function showProgress(message) {
  elements.status.textContent = message;
  elements.status.className = "banner progress";
  elements.status.classList.remove("hidden");
}

function validateRawConfig(raw) {
  const errors = [];
  for (const customer of Array.isArray(raw?.customers) ? raw.customers : []) {
    for (const domain of Array.isArray(customer.domains) ? customer.domains : []) {
      if (!normalizeDomain(domain)) {
        errors.push(`${customer.name || "Customer"}: invalid domain “${domain}”.`);
      } else if (!isRegistrableDomain(domain)) {
        errors.push(`${customer.name || "Customer"}: “${domain}” is a public suffix, not an organization domain.`);
      }
    }
    for (const address of Array.isArray(customer.addresses) ? customer.addresses : []) {
      if (!normalizeEmail(address)) {
        errors.push(`${customer.name || "Customer"}: invalid address “${address}”.`);
      }
    }
  }
  return errors;
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy;
  }
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function enabledBackfillAccounts() {
  return bootstrap.accounts.filter(account => accountConfig(account.id).enabled);
}

function customerTotalForAccount(accountId) {
  return config.customers.filter(customer =>
    customer.enabled !== false &&
    (!customer.accountIds?.length || customer.accountIds.includes(accountId))
  ).length;
}

function renderContactBackfillProgress(message) {
  if (!contactBackfillRunning) return;
  if (message.phase === "complete") {
    showProgress("Building address books — finalizing the summary…");
    return;
  }
  const accountId = message.accountId ?? "";
  const accounts = enabledBackfillAccounts();
  const accountIndex = Math.max(0, accounts.findIndex(account => account.id === accountId));
  const accountNumber = accounts.length ? accountIndex + 1 : 0;
  const state = contactBackfillProgress ??= {customersByAccount: new Map()};
  const seenCustomers = state.customersByAccount.get(accountId) ?? new Set();
  if (message.customerId || message.customerName) {
    seenCustomers.add(message.customerId || message.customerName);
  }
  state.customersByAccount.set(accountId, seenCustomers);

  const importing = message.phase === "import" || message.phase === "importing";
  const phase = importing ? "Importing contacts" : "Scanning existing mail";
  const lines = [`Building address books — ${phase.toLocaleLowerCase()}…`];
  if (message.accountName || accounts.length) {
    lines.push(
      `Account ${accountNumber} of ${accounts.length}: ${message.accountName || accountId || "Unknown account"}`
    );
  }
  if (message.customerName) {
    const customerTotal = numeric(message.customersTotal) || customerTotalForAccount(accountId);
    const customerNumber = Math.max(seenCustomers.size, numeric(message.customersProcessed));
    lines.push(
      `Customer ${customerNumber}${customerTotal ? ` of ${customerTotal} configured` : ""}: ${message.customerName}` +
      (message.folderName ? ` / ${message.folderName}` : "")
    );
  }
  const folders = message.foldersTotal == null
    ? plural(numeric(message.foldersScanned), "folder")
    : `${numeric(message.foldersScanned)} of ${numeric(message.foldersTotal)} folders`;
  lines.push([
    folders,
    plural(numeric(message.messagesScanned), "message"),
    importing ? plural(numeric(message.attempted), "contact") + " attempted" : null,
    importing ? `${numeric(message.created)} created` : null,
    importing ? `${numeric(message.existing)} existing` : null,
    importing ? `${numeric(message.failed)} failed` : null
  ].filter((value, index, values) => value && values.indexOf(value) === index).join(" · "));
  showProgress(lines.filter(Boolean).join("\n"));
}

function readableIssue(issue) {
  if (typeof issue === "string") return issue;
  if (!issue || typeof issue !== "object") return String(issue ?? "Unknown error");
  return issue.reason ?? issue.message ?? JSON.stringify(issue);
}

function countItems(value) {
  return Array.isArray(value) ? value.length : numeric(value);
}

function renderContactBackfillResult(result = {}) {
  const accounts = Array.isArray(result.accounts) ? result.accounts : [];
  const totals = result.totals ?? {};
  const skippedTotal = countItems(totals.skippedFolders) ||
    accounts.reduce((sum, account) => sum + countItems(account.skippedFolders), 0);
  const errorsTotal = accounts.reduce(
    (sum, account) => sum + countItems(account.errors),
    countItems(totals.errors)
  );
  const lines = [
    "Address-book build complete.",
    `All enabled accounts: ${plural(numeric(totals.accountsProcessed) || accounts.length, "account")} · ${plural(numeric(totals.foldersScanned), "folder")} scanned · ${plural(numeric(totals.messagesScanned), "message")} scanned`,
    `Contacts: ${numeric(totals.attempted)} attempted · ${numeric(totals.created)} created · ${numeric(totals.existing)} existing · ${numeric(totals.failed)} failed`,
    `Skipped folders: ${skippedTotal} · Errors: ${errorsTotal}`
  ];

  for (const account of accounts) {
    const accountSkipped = countItems(account.skippedFolders);
    const accountErrors = countItems(account.errors);
    lines.push(
      "",
      `${account.accountName || account.accountId || "Account"}: ${plural(numeric(account.customersScanned), "customer")} · ${plural(numeric(account.foldersScanned), "folder")} scanned · ${plural(numeric(account.messagesScanned), "message")} scanned · ${numeric(account.attempted)} attempted · ${numeric(account.created)} created · ${numeric(account.existing)} existing · ${numeric(account.failed)} failed · ${accountSkipped} skipped · ${accountErrors} errors`
    );
    for (const skipped of Array.isArray(account.skippedFolders) ? account.skippedFolders : []) {
      const location = [skipped.customerName, skipped.folderName].filter(Boolean).join(" / ");
      lines.push(`Skipped${location ? ` ${location}` : ""}: ${readableIssue(skipped)}`);
    }
    for (const error of Array.isArray(account.errors) ? account.errors : []) {
      lines.push(`Error: ${readableIssue(error)}`);
    }
  }
  showStatus(
    lines.join("\n"),
    errorsTotal > 0 || numeric(totals.failed) > 0 || skippedTotal > 0
  );
}

function accountConfig(accountId) {
  return config.accounts[accountId] ?? {
    enabled: false,
    rootFolderName: "Customers",
    customerRootReady: false,
    archiveFolderName: "Organizer Archive",
    archiveReady: false,
    autoFileIncoming: false,
    autoFileSince: null
  };
}

function renderFolderApproval(card, kind, ready) {
  const approval = card.querySelector(`.adopt-${kind}`);
  const row = card.querySelector(`.${kind}-approval`);
  const title = card.querySelector(`.${kind}-approval-title`);
  const help = card.querySelector(`.${kind}-approval-help`);
  const isRoot = kind === "root";
  approval.checked = false;
  approval.disabled = ready;
  row.classList.toggle("ready", ready);
  title.textContent = ready
    ? "Folder already approved"
    : "Use an existing folder with this name";
  help.textContent = ready
    ? isRoot
      ? "This is the approved customer root for this account."
      : "This is the approved organizer archive for this account."
    : isRoot
      ? "One-time approval: its direct customer subfolders may receive organized mail. Existing messages are not changed during setup."
      : "One-time approval: future archive actions may move messages here. Setup changes nothing already inside; recovery will treat its current contents as organizer archive mail.";
}

function normalizedFolderKey(value) {
  return value.trim().normalize("NFC").toLocaleLowerCase();
}

function matchesSavedFolderName(value, savedName) {
  return value.trim().normalize("NFC") === savedName;
}

function customerCardUsesAccount(card, accountId) {
  const selected = [...card.querySelectorAll('.scope-options input[type="checkbox"]:checked')]
    .map(input => input.value);
  return !selected.length || selected.includes(accountId);
}

function hasCustomerFolderRule(accountId, folderName) {
  const key = normalizedFolderKey(folderName);
  return [...elements.customers.querySelectorAll(".customer-card")].some(card =>
    normalizedFolderKey(card.querySelector(".customer-folder").value) === key &&
    customerCardUsesAccount(card, accountId)
  );
}

function normalizeFolderProposal(value) {
  const source = typeof value === "string" ? {folderName: value} : (value ?? {});
  const folderName = String(source.folderName ?? source.name ?? "").trim().normalize("NFC");
  const domainFromFolderName = normalizeDomain(folderName);
  const domains = Array.isArray(source.domains)
    ? source.domains
    : isRegistrableDomain(domainFromFolderName)
      ? [domainFromFolderName]
      : [];
  return {
    folderName,
    name: String(source.customerName ?? source.name ?? folderName).trim(),
    domains,
    addresses: Array.isArray(source.addresses) ? source.addresses : [],
    keywords: Array.isArray(source.keywords) ? source.keywords : [],
    enabled: source.enabled !== false,
    needsReview: Boolean(source.needsReview),
    warning: typeof source.warning === "string" ? source.warning : "",
    conflictingDomain: normalizeDomain(source.conflictingDomain) || null
  };
}

function showFolderImportStatus(message = "") {
  elements.folderImportStatus.textContent = message;
  elements.folderImportStatus.classList.toggle("hidden", !message);
}

function renderFolderImport(account, rootFolderName, proposals) {
  folderImportContext = {accountId: account.id, accountName: account.name, rootFolderName};
  elements.folderImportDescription.textContent = `${account.name} / ${rootFolderName}`;
  elements.folderImportList.replaceChildren();
  showFolderImportStatus();

  const usable = proposals
    .map(normalizeFolderProposal)
    .filter(proposal => proposal.folderName)
    .sort((left, right) => left.folderName.localeCompare(right.folderName, undefined, {
      sensitivity: "base",
      numeric: true
    }));

  for (const proposal of usable) {
    const row = elements.folderImportTemplate.content.firstElementChild.cloneNode(true);
    row._proposal = proposal;
    const duplicate = hasCustomerFolderRule(account.id, proposal.folderName);
    const checkbox = row.querySelector(".folder-import-enabled");
    checkbox.checked = !duplicate;
    checkbox.disabled = duplicate;
    row.classList.toggle("unavailable", duplicate);
    row.querySelector(".folder-import-name").textContent = proposal.folderName;
    row.querySelector(".folder-import-state").textContent = duplicate
      ? "Already assigned to a customer rule for this account"
      : proposal.warning
        ? `${proposal.warning} It will be imported disabled unless you enter ${proposal.conflictingDomain ? "a different" : "a"} valid domain.`
        : proposal.domains.length || proposal.addresses.length || proposal.keywords.length
          ? "Review the proposed matching rule before adding"
          : "No domain was inferred. It will be imported as a disabled draft for you to complete.";
    row.querySelector(".folder-import-customer-name").value = proposal.name;
    row.querySelector(".folder-import-domains").value = proposal.domains.join(", ");
    elements.folderImportList.append(row);
  }

  if (!usable.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No direct customer folders were found in this root.";
    elements.folderImportList.append(empty);
  }
  elements.addFolderImports.disabled = !usable.some(
    proposal => !hasCustomerFolderRule(account.id, proposal.folderName)
  );
  elements.folderImportDialog.showModal();
}

async function discoverCustomerFolders(card) {
  const accountId = card.dataset.accountId;
  const account = bootstrap.accounts.find(candidate => candidate.id === accountId);
  const rootFolderName = card.querySelector(".root-folder").value.trim().normalize("NFC");
  if (!rootFolderName) {
    showStatus("Enter a customer root folder name before importing its folders.", true);
    return;
  }
  setBusy(true);
  let result;
  try {
    result = await send("discoverExistingFolders", {accountId, rootFolderName});
  } catch (error) {
    showStatus(error.message, true);
    return;
  } finally {
    setBusy(false);
  }
  const proposals = Array.isArray(result.proposedCustomers)
    ? result.proposedCustomers
    : Array.isArray(result.folders)
      ? result.folders
      : [];
  renderFolderImport(account, result.rootFolderName ?? rootFolderName, proposals);
}

function closeFolderImport() {
  if (elements.folderImportDialog.open) elements.folderImportDialog.close();
  folderImportContext = null;
  showFolderImportStatus();
}

function addSelectedFolderImports() {
  if (!folderImportContext) return;
  const additions = [];
  const errors = [];
  for (const row of elements.folderImportList.querySelectorAll(".folder-import-row")) {
    row.classList.remove("invalid");
    if (!row.querySelector(".folder-import-enabled").checked) continue;
    const proposal = row._proposal;
    const name = row.querySelector(".folder-import-customer-name").value.trim();
    const rawDomains = splitList(row.querySelector(".folder-import-domains").value);
    const invalidDomains = rawDomains.filter(
      domain => !normalizeDomain(domain) || !isRegistrableDomain(domain)
    );
    const domains = rawDomains.map(normalizeDomain).filter(Boolean);
    if (!name) {
      errors.push(`${proposal.folderName}: enter a customer name.`);
      row.classList.add("invalid");
    }
    if (invalidDomains.length) {
      errors.push(`${proposal.folderName}: invalid organization domain ${invalidDomains.join(", ")}.`);
      row.classList.add("invalid");
    }
    if (!name || invalidDomains.length) {
      continue;
    }
    const hasMatcher = domains.length || proposal.addresses.length || proposal.keywords.length;
    const retainsConflict = Boolean(
      proposal.conflictingDomain && domains.includes(proposal.conflictingDomain)
    );
    const proposedDomains = proposal.domains.map(normalizeDomain).filter(Boolean);
    const domainChanged = domains.length !== proposedDomains.length ||
      domains.some(domain => !proposedDomains.includes(domain));
    additions.push({
      id: uid(),
      enabled: Boolean(hasMatcher) && !retainsConflict && (proposal.enabled || domainChanged),
      name,
      folderName: proposal.folderName,
      domains,
      addresses: proposal.addresses,
      keywords: proposal.keywords,
      accountIds: [folderImportContext.accountId]
    });
  }
  if (errors.length) {
    showFolderImportStatus(errors.join("\n"));
    return;
  }
  if (!additions.length) {
    showFolderImportStatus("Select at least one folder to add.");
    return;
  }
  for (const customer of customersByName(additions).reverse()) {
    appendCustomer(customer, {prepend: true, expanded: !customer.enabled});
  }
  const disabledCount = additions.filter(customer => !customer.enabled).length;
  const {accountName, rootFolderName} = folderImportContext;
  closeFolderImport();
  showStatus(
    `${additions.length} existing folder${additions.length === 1 ? "" : "s"} from ${accountName} / ${rootFolderName} added as customer rules for review.${disabledCount ? ` ${disabledCount} ${disabledCount === 1 ? "needs" : "need"} a matching rule and remains disabled.` : ""} Review them, then save settings. No folders or messages were changed.`
  );
  elements.customers.scrollIntoView({behavior: "smooth", block: "start"});
}

function renderAccounts() {
  elements.accounts.replaceChildren();
  for (const account of bootstrap.accounts) {
    const card = elements.accountTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.accountId = account.id;
    const value = accountConfig(account.id);
    card.querySelector(".account-name").textContent = account.name;
    card.querySelector(".account-email").textContent = account.identities.map(identity => identity.email).filter(Boolean).join(", ") || account.type;
    card.querySelector(".account-enabled").checked = value.enabled;
    const rootFolder = card.querySelector(".root-folder");
    const archiveFolder = card.querySelector(".archive-folder");
    rootFolder.value = value.rootFolderName;
    archiveFolder.value = value.archiveFolderName;
    card.querySelector(".import-customer-folders").addEventListener(
      "click",
      () => discoverCustomerFolders(card)
    );
    const autoFile = card.querySelector(".auto-file");
    const contactsReady = Boolean(
      bootstrap.managedContactBooks?.[account.id]?.addressBookId &&
      !bootstrap.managedContactBookErrors?.[account.id]
    );
    autoFile.checked = value.autoFileIncoming && value.customerRootReady && contactsReady;
    const autoHelp = card.querySelector(".auto-file-help");
    const updateRootState = () => {
      const rootReady = value.customerRootReady &&
        matchesSavedFolderName(rootFolder.value, value.rootFolderName);
      const automationReady = rootReady && contactsReady;
      renderFolderApproval(card, "root", rootReady);
      autoFile.disabled = !automationReady;
      if (!automationReady) autoFile.checked = false;
      autoHelp.textContent = automationReady
        ? "Sender/recipient rules only. After each matched move, customer email contacts are added to the address book. A successful manual preview is recommended first."
        : rootReady
          ? bootstrap.managedContactBookErrors?.[account.id] ||
            "Run Save & set up folders to create the managed customer address book."
          : "Run Save & set up folders before automatic filing and contact capture can be enabled.";
    };
    const updateArchiveState = () => {
      const ready = value.archiveReady &&
        matchesSavedFolderName(archiveFolder.value, value.archiveFolderName);
      renderFolderApproval(card, "archive", ready);
    };
    rootFolder.addEventListener("input", updateRootState);
    archiveFolder.addEventListener("input", updateArchiveState);
    updateRootState();
    updateArchiveState();
    elements.accounts.append(card);
  }
}

function scopeOptions(container, selectedAccountIds) {
  container.replaceChildren();
  for (const account of bootstrap.accounts) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = account.id;
    checkbox.checked = selectedAccountIds.includes(account.id);
    const span = document.createElement("span");
    span.textContent = account.name;
    label.append(checkbox, span);
    container.append(label);
  }
  const available = new Set(bootstrap.accounts.map(account => account.id));
  for (const accountId of selectedAccountIds.filter(id => !available.has(id))) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = accountId;
    checkbox.checked = true;
    const span = document.createElement("span");
    span.textContent = `Unavailable account: ${accountId} (uncheck to remove)`;
    label.append(checkbox, span);
    container.append(label);
  }
}

function updateCustomerSummary(card) {
  const name = card.querySelector(".customer-name").value.trim();
  const folder = card.querySelector(".customer-folder").value.trim();
  const [primaryDomain] = splitList(card.querySelector(".customer-domains").value);
  const enabled = card.querySelector(".customer-enabled").checked;
  const displayName = name || "New customer";
  const details = [primaryDomain, folder ? `Folder: ${folder}` : ""]
    .filter(Boolean)
    .join(" · ");

  card.querySelector(".customer-summary-name").textContent = displayName;
  card.querySelector(".customer-summary-details").textContent = details || "No matching rules yet";
  const status = card.querySelector(".customer-summary-status");
  status.textContent = enabled ? "Enabled" : "Disabled";
  status.classList.toggle("disabled", !enabled);
  card.querySelector(".remove-customer").setAttribute(
    "aria-label",
    `Remove ${displayName}`
  );
}

function appendCustomer(
  customer = {},
  {prepend = false, expanded = false, focus = false} = {}
) {
  const card = elements.customerTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.customerId = customer.id || uid();
  card.open = expanded;
  card.querySelector(".customer-enabled").checked = customer.enabled !== false;
  card.querySelector(".customer-name").value = customer.name ?? "";
  card.querySelector(".customer-folder").value = customer.folderName ?? "";
  if (customer.folderName) {
    card.querySelector(".customer-folder").dataset.edited = "true";
  }
  card.querySelector(".customer-domains").value = (customer.domains ?? []).join(", ");
  card.querySelector(".customer-addresses").value = (customer.addresses ?? []).join(", ");
  card.querySelector(".customer-keywords").value = (customer.keywords ?? []).join(", ");
  scopeOptions(card.querySelector(".scope-options"), customer.accountIds ?? []);
  card.querySelector(".customer-name").addEventListener("input", event => {
    const folder = card.querySelector(".customer-folder");
    if (!folder.dataset.edited) folder.value = event.target.value;
    updateCustomerSummary(card);
  });
  card.querySelector(".customer-folder").addEventListener("input", event => {
    event.target.dataset.edited = "true";
    updateCustomerSummary(card);
  });
  card.querySelector(".customer-domains").addEventListener("input", () => {
    updateCustomerSummary(card);
  });
  card.querySelector(".customer-enabled").addEventListener("change", () => {
    updateCustomerSummary(card);
  });
  card.querySelector(".remove-customer").addEventListener("click", () => card.remove());
  updateCustomerSummary(card);
  if (prepend) {
    elements.customers.prepend(card);
  } else {
    elements.customers.append(card);
  }
  if (focus) {
    requestAnimationFrame(() => {
      card.scrollIntoView({behavior: "smooth", block: "start"});
      card.querySelector(".customer-name").focus({preventScroll: true});
    });
  }
  return card;
}

function render() {
  renderAccounts();
  elements.customers.replaceChildren();
  for (const customer of customersByName(config.customers)) {
    appendCustomer(customer);
  }
  elements.defaultDays.value = String(config.defaultDays);
  elements.maxMessages.value = String(config.maxMessagesPerRun);
  elements.scanSubject.checked = config.scanSubject;
  elements.scanBody.checked = config.scanBody;
  elements.preserveFlagged.checked = config.preserveFlagged;
}

function collectConfig() {
  const next = structuredClone(config);
  next.defaultDays = Number(elements.defaultDays.value);
  next.maxMessagesPerRun = Number(elements.maxMessages.value);
  next.scanSubject = elements.scanSubject.checked;
  next.scanBody = elements.scanBody.checked;
  next.preserveFlagged = elements.preserveFlagged.checked;
  next.accounts = {};
  for (const card of elements.accounts.querySelectorAll(".account-card")) {
    next.accounts[card.dataset.accountId] = {
      enabled: card.querySelector(".account-enabled").checked,
      rootFolderName: card.querySelector(".root-folder").value,
      archiveFolderName: card.querySelector(".archive-folder").value,
      autoFileIncoming: card.querySelector(".auto-file").checked
    };
  }
  next.customers = [...elements.customers.querySelectorAll(".customer-card")].map(card => ({
    id: card.dataset.customerId,
    enabled: card.querySelector(".customer-enabled").checked,
    name: card.querySelector(".customer-name").value,
    folderName: card.querySelector(".customer-folder").value,
    domains: splitList(card.querySelector(".customer-domains").value),
    addresses: splitList(card.querySelector(".customer-addresses").value),
    keywords: splitList(card.querySelector(".customer-keywords").value),
    accountIds: [...card.querySelectorAll('.scope-options input[type="checkbox"]:checked')].map(input => input.value)
  }));
  return next;
}

function collectFolderApprovals() {
  const folderApprovals = {};
  for (const card of elements.accounts.querySelectorAll(".account-card")) {
    const adoptExistingRoot = card.querySelector(".adopt-root").checked;
    const adoptExistingArchive = card.querySelector(".adopt-archive").checked;
    if (!adoptExistingRoot && !adoptExistingArchive) continue;
    folderApprovals[card.dataset.accountId] = {
      rootFolderName: card.querySelector(".root-folder").value.trim().normalize("NFC"),
      archiveFolderName: card.querySelector(".archive-folder").value.trim().normalize("NFC"),
      adoptExistingRoot,
      adoptExistingArchive
    };
  }
  return folderApprovals;
}

async function saveSettings(quiet = false) {
  setBusy(true);
  try {
    const raw = collectConfig();
    const rawErrors = validateRawConfig(raw);
    if (rawErrors.length) {
      throw new Error(rawErrors.join("\n"));
    }
    const response = await send("saveConfig", {config: raw});
    config = response.config;
    renderAccounts();
    if (!quiet) {
      const automaticAccounts = Object.values(config.accounts).filter(
        account => account.enabled && account.autoFileIncoming
      ).length;
      showStatus(
        automaticAccounts
          ? `Settings saved. Automatic Inbox filing is active for ${automaticAccounts} account${automaticAccounts === 1 ? "" : "s"}.`
          : "Settings saved. Create a preview from the toolbar before applying manual moves."
      );
    }
    return true;
  } catch (error) {
    showStatus(error.message, true);
    return false;
  } finally {
    setBusy(false);
  }
}

elements.addCustomer.addEventListener("click", () => {
  appendCustomer({}, {prepend: true, expanded: true, focus: true});
});
elements.cancelFolderImportTop.addEventListener("click", closeFolderImport);
elements.cancelFolderImport.addEventListener("click", closeFolderImport);
elements.addFolderImports.addEventListener("click", addSelectedFolderImports);
elements.folderImportDialog.addEventListener("close", () => {
  folderImportContext = null;
  showFolderImportStatus();
});
elements.save.addEventListener("click", () => saveSettings());
elements.buildAddressBooks.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Build address books from existing mail?\n\n" +
    "This scans every message across all dates in the configured customer folders and their subfolders for all enabled accounts. " +
    "It reads only From, To, Cc, and Bcc headers and applies your exact customer rules. " +
    "Existing contacts are skipped. No messages or folders will be changed.\n\n" +
    "Large mailboxes may take some time. Keep Thunderbird and this Settings tab open until the summary appears. " +
    "If the run is interrupted, start it again; existing contacts will be skipped."
  );
  if (!confirmed) return;
  if (!(await saveSettings(true))) return;

  contactBackfillRunning = true;
  contactBackfillProgress = {customersByAccount: new Map()};
  setBusy(true);
  elements.mailAccountsPanel.setAttribute("aria-busy", "true");
  showProgress("Building address books — preparing enabled accounts…");
  try {
    renderContactBackfillResult(await send("backfillContacts"));
  } catch (error) {
    showStatus(`Could not build address books: ${error.message}`, true);
  } finally {
    contactBackfillRunning = false;
    contactBackfillProgress = null;
    elements.mailAccountsPanel.removeAttribute("aria-busy");
    setBusy(false);
  }
});
elements.setupFolders.addEventListener("click", async () => {
  // Approvals are intentionally one-use and are captured before saveSettings
  // rerenders the account cards. They never become durable configuration.
  const folderApprovals = collectFolderApprovals();
  if (!(await saveSettings(true))) return;
  setBusy(true);
  try {
    const result = await send("setupFolders", {folderApprovals});
    config = result.config;
    bootstrap.managedContactBooks = result.managedContactBooks;
    bootstrap.managedContactBookErrors ??= {};
    for (const contactBook of result.result.contactBooks ?? []) {
      delete bootstrap.managedContactBookErrors[contactBook.accountId];
    }
    renderAccounts();
    const details = result.result.errors.length
      ? `\n${result.result.errors.join("\n")}`
      : "";
    const contactBookCount = result.result.contactBooks?.length ?? 0;
    showStatus(
      `${result.result.folders.length} organizer folder destination${result.result.folders.length === 1 ? "" : "s"} and ${contactBookCount} managed contact book${contactBookCount === 1 ? "" : "s"} ready.${details}`,
      result.result.errors.length > 0
    );
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setBusy(false);
  }
});

messenger.runtime.onMessage.addListener(message => {
  if (!message?.dmo || message.event !== "contactBackfillProgress") return;
  if (message.phase === "complete" && message.result) {
    renderContactBackfillResult(message.result);
    return;
  }
  renderContactBackfillProgress(message);
});
elements.export.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(collectConfig(), null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `domain-mail-organizer-settings-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});
elements.import.addEventListener("click", () => elements.importFile.click());
elements.importFile.addEventListener("change", async () => {
  const [file] = elements.importFile.files;
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    const rawErrors = validateRawConfig(imported);
    if (rawErrors.length) {
      throw new Error(rawErrors.join("\n"));
    }
    const prepared = await send("prepareConfig", {config: imported});
    config = prepared.config;
    render();
    showStatus("Imported settings are shown below. Review them, then choose Save settings.");
  } catch (error) {
    showStatus(`Could not import JSON: ${error.message}`, true);
  } finally {
    elements.importFile.value = "";
  }
});

try {
  bootstrap = await send("getBootstrap");
  config = bootstrap.config;
  render();
} catch (error) {
  showStatus(error.message, true);
}
