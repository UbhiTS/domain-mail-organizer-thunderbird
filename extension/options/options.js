// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {isRegistrableDomain, normalizeDomain, normalizeEmail} from "../lib/rules.js";
import {internalDomainsFromIdentities} from "../lib/contacts.js";
import {assertSettingsImportFileSize} from "../lib/input-limits.js";
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
  buildAddressBooks: document.querySelector("#buildAddressBooks"),
  mailAccountsPanel: document.querySelector("#mailAccountsPanel"),
  manualToolsPanel: document.querySelector("#manualToolsPanel"),
  manualAccount: document.querySelector("#manualAccount"),
  manualDays: document.querySelector("#manualDays"),
  manualToolsNotice: document.querySelector("#manualToolsNotice"),
  processEntireInbox: document.querySelector("#processEntireInbox"),
  recoverArchive: document.querySelector("#recoverArchive"),
  export: document.querySelector("#export"),
  import: document.querySelector("#import"),
  importFile: document.querySelector("#importFile")
};

let bootstrap;
let config;
let contactBackfillRunning = false;
let contactBackfillProgress = null;

const BROAD_CONSUMER_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com"
]);

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
  if (!busy) updateManualToolsReadiness();
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
    initialized: false,
    enabled: false,
    rootFolderName: "Domains",
    customerRootReady: false,
    archiveFolderName: "Archive",
    archiveReady: false,
    autoFileIncoming: false,
    autoFileRequested: true,
    autoFileSince: null,
    internalContactDomains: []
  };
}

function internalDomainLabels(domains) {
  return domains.map(domain => `@${domain}`).join(", ");
}

function renderInternalContactSetting(card, account, value) {
  const help = card.querySelector(".internal-contacts-help");
  const options = card.querySelector(".internal-domain-options");
  const master = card.querySelector(".capture-internal");
  const detected = internalDomainsFromIdentities(account.identities);
  const saved = value.internalContactDomains ?? [];
  const savedSet = new Set(saved);
  options.replaceChildren();

  if (!detected.length) {
    master.checked = false;
    master.disabled = true;
    help.textContent = saved.length
      ? `Saved approval for ${internalDomainLabels(saved)} is paused because no current Thunderbird identity verifies it. Add or restore the identity, then save again.`
      : "No eligible domain was found in this account's identities, so internal capture cannot be enabled.";
    return;
  }

  help.textContent = "Select each exact identity domain you want treated as internal. Used after automatic customer moves and by Build address books from existing mail. Your own identity addresses are excluded; subdomains are not included.";
  const stale = saved.filter(domain => !detected.includes(domain));
  if (stale.length) {
    help.textContent += ` No current identity verifies ${internalDomainLabels(stale)}, so it will be removed when you save.`;
  }
  for (const domain of detected) {
    const label = document.createElement("label");
    label.className = "internal-domain-option";
    const checkbox = document.createElement("input");
    checkbox.className = "capture-internal-domain";
    checkbox.type = "checkbox";
    checkbox.value = domain;
    checkbox.checked = !value.initialized || savedSet.has(domain);
    const text = document.createElement("span");
    text.textContent = `@${domain}`;
    label.append(checkbox, text);
    options.append(label);
    if (BROAD_CONSUMER_DOMAINS.has(domain)) {
      const caution = document.createElement("small");
      caution.textContent = `Caution: @${domain} is a shared consumer domain and may add unrelated people.`;
      label.append(caution);
    }
  }
  const domainCheckboxes = [...options.querySelectorAll(".capture-internal-domain")];
  const syncMaster = () => {
    const selected = domainCheckboxes.filter(checkbox => checkbox.checked).length;
    master.checked = selected === domainCheckboxes.length;
    master.indeterminate = selected > 0 && selected < domainCheckboxes.length;
  };
  master.disabled = false;
  master.addEventListener("change", () => {
    for (const checkbox of domainCheckboxes) checkbox.checked = master.checked;
    master.indeterminate = false;
  });
  for (const checkbox of domainCheckboxes) checkbox.addEventListener("change", syncMaster);
  syncMaster();
}

function updateManualToolsReadiness() {
  const accountId = elements.manualAccount.value;
  const ready = Boolean(accountId) && config.customers.some(customer =>
    customer.enabled && (!customer.accountIds.length || customer.accountIds.includes(accountId))
  );
  elements.processEntireInbox.disabled = !ready;
  elements.recoverArchive.disabled = !ready;
  elements.manualToolsNotice.classList.toggle("hidden", ready);
}

function renderManualTools() {
  const selectedAccountId = elements.manualAccount.value;
  elements.manualAccount.replaceChildren();
  const enabledAccounts = bootstrap.accounts.filter(account => accountConfig(account.id).enabled);
  for (const account of enabledAccounts) {
    const option = document.createElement("option");
    option.value = account.id;
    const identity = account.identities.find(candidate => candidate.email)?.email;
    option.textContent = identity ? `${account.name} — ${identity}` : account.name;
    elements.manualAccount.append(option);
  }
  if (!enabledAccounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No enabled mail accounts";
    elements.manualAccount.append(option);
  }
  elements.manualAccount.disabled = !enabledAccounts.length;
  if (enabledAccounts.some(account => account.id === selectedAccountId)) {
    elements.manualAccount.value = selectedAccountId;
  }
  elements.manualDays.value = String(config.defaultDays);
  updateManualToolsReadiness();
}

function matchesSavedFolderName(value, savedName) {
  return value.trim().normalize("NFC") === savedName;
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
    const autoFile = card.querySelector(".auto-file");
    renderInternalContactSetting(card, account, value);
    const contactsReady = Boolean(
      bootstrap.managedContactBooks?.[account.id]?.addressBookId &&
      !bootstrap.managedContactBookErrors?.[account.id]
    );
    autoFile.checked = value.autoFileRequested !== false;
    const autoHelp = card.querySelector(".auto-file-help");
    const updateRootState = () => {
      const rootReady = value.customerRootReady &&
        matchesSavedFolderName(rootFolder.value, value.rootFolderName);
      const automationReady = Boolean(
        value.enabled && value.autoFileIncoming && rootReady && contactsReady
      );
      autoHelp.textContent = !autoFile.checked
        ? "Automatic Inbox filing and automatic contact capture are off for this account."
        : automationReady
          ? "Sender/recipient rules only. After Thunderbird confirms each destination move, customer contacts and any selected internal coworkers are added to the address book. A successful manual preview is recommended first."
        : rootReady
          ? bootstrap.managedContactBookErrors?.[account.id] ||
            "Your preference is saved; choose Save & set up to create the managed customer address book and activate it."
          : "Your preference is saved; choose Save & set up to reuse or create the folders and activate it.";
    };
    rootFolder.addEventListener("input", updateRootState);
    autoFile.addEventListener("change", updateRootState);
    card.querySelector(".account-enabled").addEventListener("change", updateRootState);
    updateRootState();
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
  renderManualTools();
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
    const internalContactDomains = [
      ...card.querySelectorAll(".capture-internal-domain:checked")
    ].map(input => input.value);
    next.accounts[card.dataset.accountId] = {
      initialized: true,
      enabled: card.querySelector(".account-enabled").checked,
      rootFolderName: card.querySelector(".root-folder").value,
      archiveFolderName: card.querySelector(".archive-folder").value,
      autoFileRequested: card.querySelector(".auto-file").checked,
      autoFileIncoming: card.querySelector(".auto-file").checked,
      internalContactDomains
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
    const setup = await send("setupFolders");
    config = setup.config;
    bootstrap.managedContactBooks = setup.managedContactBooks;
    bootstrap.managedContactBookErrors ??= {};
    for (const contactBook of setup.result.contactBooks ?? []) {
      delete bootstrap.managedContactBookErrors[contactBook.accountId];
    }
    render();
    const setupErrors = setup.result.errors ?? [];
    if (quiet && setupErrors.length) {
      showStatus(
        `Settings were saved, but setup needs attention:\n${setupErrors.join("\n")}`,
        true
      );
    }
    if (!quiet) {
      const automaticAccounts = Object.values(config.accounts).filter(
        account => account.enabled && account.autoFileIncoming
      ).length;
      const pendingAutomaticAccounts = Object.values(config.accounts).filter(
        account => account.enabled && account.autoFileRequested && !account.autoFileIncoming
      ).length;
      const imported = setup.result.importedCustomers?.length ?? 0;
      const setupSummary = `${setup.result.folders.length} mail destination${setup.result.folders.length === 1 ? "" : "s"} verified; ${imported} customer rule${imported === 1 ? "" : "s"} imported.`;
      const automaticSummary = automaticAccounts
        ? ` Automatic Inbox filing is active for ${automaticAccounts} account${automaticAccounts === 1 ? "" : "s"}.`
        : pendingAutomaticAccounts
          ? ` Automatic filing remains selected for ${pendingAutomaticAccounts} account${pendingAutomaticAccounts === 1 ? "" : "s"}, but setup needs attention.`
          : " Automatic filing is off.";
      showStatus(
        `Settings saved and setup completed. ${setupSummary}${automaticSummary}${setupErrors.length ? `\n${setupErrors.join("\n")}` : ""}`,
        setupErrors.length > 0
      );
    }
    return setupErrors.length === 0;
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
elements.save.addEventListener("click", () => saveSettings());
elements.manualAccount.addEventListener("change", updateManualToolsReadiness);
elements.processEntireInbox.addEventListener("click", async () => {
  setBusy(true);
  elements.manualToolsPanel.setAttribute("aria-busy", "true");
  showProgress("Scanning the entire Inbox for the first read-only batch…");
  try {
    await send("createAndOpenBulkPlan", {accountId: elements.manualAccount.value});
    showStatus("The first entire-Inbox review batch is open in a new tab.");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    elements.manualToolsPanel.removeAttribute("aria-busy");
    setBusy(false);
  }
});
elements.recoverArchive.addEventListener("click", async () => {
  setBusy(true);
  elements.manualToolsPanel.setAttribute("aria-busy", "true");
  showProgress("Building a read-only Archive recovery review…");
  try {
    await send("createAndOpenPlan", {
      request: {
        kind: "organize",
        source: "archive",
        accountId: elements.manualAccount.value,
        days: Number(elements.manualDays.value)
      }
    });
    showStatus("The Archive recovery review is open in a new tab.");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    elements.manualToolsPanel.removeAttribute("aria-busy");
    setBusy(false);
  }
});
elements.buildAddressBooks.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Build address books from existing mail?\n\n" +
    "This scans every message across all dates in the configured customer folders and their subfolders for all enabled accounts. " +
    "It reads only From, To, Cc, and Bcc headers and applies your exact customer rules plus any exact internal domains you enabled for each account. " +
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
    assertSettingsImportFileSize(file);
    const imported = JSON.parse(await file.text());
    const rawErrors = validateRawConfig(imported);
    if (rawErrors.length) {
      throw new Error(rawErrors.join("\n"));
    }
    const prepared = await send("prepareConfig", {config: imported});
    config = prepared.config;
    render();
    showStatus("Imported settings are shown below. Review them, then choose Save & set up.");
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
