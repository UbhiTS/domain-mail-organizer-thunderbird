// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
const elements = {
  account: document.querySelector("#account"),
  days: document.querySelector("#days"),
  inbox: document.querySelector("#inbox"),
  bulkInbox: document.querySelector("#bulkInbox"),
  archive: document.querySelector("#archive"),
  archiveMail: document.querySelector("#archiveMail"),
  addresses: document.querySelector("#addresses"),
  settings: document.querySelector("#settings"),
  status: document.querySelector("#status"),
  setupNotice: document.querySelector("#setupNotice"),
  lastRun: document.querySelector("#lastRun"),
  automaticReviews: document.querySelector("#automaticReviews")
};

let bootstrap;

function send(command, extra = {}) {
  return messenger.runtime.sendMessage({dmo: true, command, ...extra});
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy;
  }
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function renderLastRun(lastRun) {
  if (!lastRun) {
    return;
  }
  const title = document.createElement("strong");
  title.textContent = "Last run";
  const details = document.createElement("span");
  const date = new Date(lastRun.finishedAt).toLocaleString();
  const account = lastRun.accountName ? ` · ${lastRun.accountName}` : "";
  const counts = `${lastRun.completed}/${lastRun.attempted} completed`;
  const failures = lastRun.failed ? ` · ${lastRun.failed} failed` : "";
  const contactCounts = Number.isFinite(lastRun.contactsAttempted)
    ? ` · contacts: ${lastRun.contactsCreated ?? 0} added, ${lastRun.contactsExisting ?? 0} existing${lastRun.contactsFailed ? `, ${lastRun.contactsFailed} failed` : ""}`
    : "";
  const error = lastRun.error ? ` · ${lastRun.error}` : "";
  details.textContent = `${lastRun.title}${account} · ${counts}${failures}${contactCounts}${error} · ${date}`;
  elements.lastRun.replaceChildren(title, details);
  elements.lastRun.classList.remove("hidden");
}

function populate() {
  elements.account.replaceChildren();
  const enabled = bootstrap.accounts.filter(account => bootstrap.config.accounts[account.id]?.enabled);
  for (const account of enabled) {
    const option = document.createElement("option");
    option.value = account.id;
    const identity = account.identities.find(candidate => candidate.email)?.email;
    option.textContent = identity ? `${account.name} — ${identity}` : account.name;
    elements.account.append(option);
  }
  elements.days.value = String(bootstrap.config.defaultDays);
  updateReadiness();
  renderLastRun(bootstrap.lastRun);
  renderAutomaticReviews();
}

function renderAutomaticReviews() {
  const reviews = (bootstrap.automaticReviews ?? []).filter(
    review => review.accountId === elements.account.value
  );
  elements.automaticReviews.classList.add("hidden");
  elements.automaticReviews.replaceChildren();
  if (!reviews.length) return;
  const title = document.createElement("strong");
  const reviewCount = reviews.reduce((total, review) => total + (review.count ?? 1), 0);
  title.textContent = `${reviewCount} Inbox message${reviewCount === 1 ? "" : "s"} need manual review`;
  const details = document.createElement("span");
  const examples = reviews
    .slice(0, 2)
    .map(review => review.subject || review.author || "Untitled message")
    .join("; ");
  details.textContent = `Check whether these messages remain in Inbox and move them manually. The extension will not retry them automatically.${examples ? ` ${examples}` : ""}`;
  elements.automaticReviews.replaceChildren(title, details);
  elements.automaticReviews.classList.remove("hidden");
}

function updateReadiness() {
  const accountId = elements.account.value;
  const ready = Boolean(accountId) && bootstrap.config.customers.some(customer =>
    customer.enabled && (!customer.accountIds.length || customer.accountIds.includes(accountId))
  );
  elements.setupNotice.classList.toggle("hidden", ready);
  for (const button of [
    elements.inbox,
    elements.bulkInbox,
    elements.archive,
    elements.archiveMail,
    elements.addresses
  ]) {
    button.disabled = !ready;
  }
}

async function createAndOpenPlan(kind, source, forceAll = false) {
  setBusy(true);
  setStatus("Building a read-only preview…");
  try {
    await send("createAndOpenPlan", {
      request: {
        kind,
        source,
        accountId: elements.account.value,
        days: forceAll ? 0 : Number(elements.days.value)
      }
    });
    window.close();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function createAndOpenBulkPlan() {
  setBusy(true);
  setStatus("Scanning the entire Inbox for the first read-only batch…");
  try {
    await send("createAndOpenBulkPlan", {accountId: elements.account.value});
    window.close();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

elements.inbox.addEventListener("click", () => createAndOpenPlan("organize", "inbox"));
elements.bulkInbox.addEventListener("click", createAndOpenBulkPlan);
elements.archive.addEventListener("click", () => createAndOpenPlan("organize", "archive"));
elements.archiveMail.addEventListener("click", () => createAndOpenPlan("archive", "inbox", true));
elements.addresses.addEventListener("click", () => createAndOpenPlan("addresses", "current"));
elements.settings.addEventListener("click", async () => {
  await send("openSettings");
  window.close();
});
elements.account.addEventListener("change", () => {
  updateReadiness();
  renderAutomaticReviews();
});

try {
  bootstrap = await send("getBootstrap");
  populate();
} catch (error) {
  setStatus(error.message, true);
}
