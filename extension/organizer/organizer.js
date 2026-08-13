// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {newestMessagesFirst} from "../lib/sort.js";

const query = new URLSearchParams(location.search);
const planId = query.get("plan");
let plan;
let batchApplied = false;
let operationBusy = false;
const completedItemIds = new Set();
const failedItemIds = new Set();

const elements = {
  title: document.querySelector("#title"),
  description: document.querySelector("#description"),
  loading: document.querySelector("#loading"),
  error: document.querySelector("#error"),
  scanNotice: document.querySelector("#scanNotice"),
  content: document.querySelector("#content"),
  summary: document.querySelector("#summary"),
  toolbar: document.querySelector("#toolbar"),
  selectAll: document.querySelector("#selectAll"),
  selectNone: document.querySelector("#selectNone"),
  selectionCount: document.querySelector("#selectionCount"),
  apply: document.querySelector("#apply"),
  nextBatch: document.querySelector("#nextBatch"),
  copyAddresses: document.querySelector("#copyAddresses"),
  progress: document.querySelector("#progress"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  result: document.querySelector("#result"),
  table: document.querySelector("#planTable"),
  tableBody: document.querySelector("#planTable tbody"),
  addressList: document.querySelector("#addressList"),
  settings: document.querySelector("#settings")
};

function send(command, extra = {}) {
  return messenger.runtime.sendMessage({dmo: true, command, ...extra});
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text ?? "";
  if (className) td.className = className;
  return td;
}

function summaryCard(label, count) {
  const card = document.createElement("div");
  card.className = "summary-card";
  const strong = document.createElement("strong");
  strong.textContent = formatCount(count);
  const span = document.createElement("span");
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function formatCount(count) {
  return Number(count ?? 0).toLocaleString();
}

function scanState() {
  const bulk = plan?.bulk ?? null;
  const rawStopReason = bulk?.stopReason ?? plan?.stopReason ?? null;
  const stopReason = rawStopReason
    ? String(rawStopReason)
      .replace(/([a-z])([A-Z])/gu, "$1-$2")
      .replaceAll("_", "-")
      .toLowerCase()
    : null;
  return {
    isBulk: Boolean(bulk),
    batchNumber: Number(bulk?.batchNumber) || 1,
    examined: Number(bulk?.examined ?? plan?.scanned ?? plan?.summary?.total) || 0,
    totalExamined: Number(bulk?.totalExamined ?? bulk?.examined ?? plan?.scanned ?? plan?.summary?.total) || 0,
    scanComplete: Boolean(bulk?.scanComplete ?? plan?.scanComplete),
    stopReason,
    rowsSampled: Boolean(bulk?.rowsSampled ?? plan?.rowsSampled)
  };
}

function remainingActionCount() {
  return (plan?.items ?? []).filter(item => item.action && !completedItemIds.has(item.id)).length;
}

function renderSummary() {
  const state = scanState();
  if (plan.kind === "addresses") {
    elements.summary.replaceChildren(
      summaryCard("Messages scanned", plan.scanned),
      summaryCard("Unique addresses", plan.addresses?.length)
    );
    return;
  }
  const scanned = state.isBulk ? state.examined : plan.summary.total;
  elements.summary.replaceChildren(
    summaryCard(state.isBulk ? "Examined this batch" : "Scanned", scanned),
    summaryCard("Ready", remainingActionCount()),
    summaryCard("Ambiguous", plan.summary.ambiguous),
    summaryCard("Unmatched", plan.summary.unmatched),
    summaryCard("Protected / skipped", plan.summary.skipped)
  );
}

function renderScanNotice() {
  const state = scanState();
  const ready = remainingActionCount();
  const notice = elements.scanNotice;
  notice.className = "banner hidden";
  notice.textContent = "";

  if (state.isBulk) {
    const countDetails = `${formatCount(state.examined)} message${state.examined === 1 ? "" : "s"} in this batch; ${formatCount(state.totalExamined)} total`;
    let message;
    let style = "info";

    if (state.scanComplete) {
      if (ready) {
        message = `Batch ${state.batchNumber} completed the Inbox scan after examining ${countDetails}. Review and apply the ${ready} ready action${ready === 1 ? "" : "s"}.`;
      } else {
        message = `Entire Inbox scan complete after examining ${formatCount(state.totalExamined)} message${state.totalExamined === 1 ? "" : "s"}. No customer moves remain in this run.`;
        style = "success";
      }
    } else if (ready === 0 && (batchApplied || plan.summary.actionable === 0)) {
      message = `Batch ${state.batchNumber} is complete after examining ${countDetails}. Preview the next read-only batch to continue.`;
      style = "success";
    } else if (["action-limit", "action-cap", "batch-full"].includes(state.stopReason)) {
      message = `Batch ${state.batchNumber} is full: ${plan.summary.actionable} action${plan.summary.actionable === 1 ? "" : "s"} found after examining ${countDetails}. Review and apply this batch before continuing.`;
      style = "warning";
    } else if (["scan-budget", "safety-budget"].includes(state.stopReason)) {
      message = `Batch ${state.batchNumber} paused at the scan safety limit after examining ${countDetails}. Review and apply any ready actions before continuing.`;
      style = "warning";
    } else {
      message = `Batch ${state.batchNumber} examined ${countDetails}. More Inbox messages remain.`;
    }

    if (state.rowsSampled) {
      message += " All actions from the examined messages are included; non-actionable rows were sampled.";
    }
    notice.textContent = message;
    notice.className = `banner ${style}`;
    return;
  }

  if (["action-limit", "action-cap", "batch-full"].includes(state.stopReason)) {
    notice.textContent = `This preview reached its action limit after examining ${formatCount(state.examined)} messages. Apply this batch, then create a fresh preview to continue.`;
    notice.className = "banner warning";
  } else if (["scan-budget", "safety-budget"].includes(state.stopReason)) {
    notice.textContent = `This preview reached its scan safety limit after examining ${formatCount(state.examined)} messages. Some messages were not examined; narrow the time window or create another preview after Apply.`;
    notice.className = "banner warning";
  } else if (state.rowsSampled) {
    notice.textContent = `The scan is complete after examining ${formatCount(state.examined)} messages. All actions are included; non-actionable rows were sampled.`;
    notice.className = "banner info";
  } else if (plan.truncated) {
    notice.textContent = `This preview stopped after examining ${formatCount(plan.scanned ?? plan.summary.total)} messages. Actionable messages are prioritized; other results may be a sample. Apply this batch, narrow the time window, or preview again to continue.`;
    notice.className = "banner warning";
  }
}

function renderItems() {
  elements.tableBody.replaceChildren();
  for (const item of newestMessagesFirst(plan.items)) {
    const row = document.createElement("tr");
    row.dataset.itemId = item.id ?? "";
    const checkCell = document.createElement("td");
    checkCell.className = "check-column";
    if (item.action) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = plan.kind !== "archive";
      checkbox.dataset.itemId = item.id;
      checkbox.setAttribute("aria-label", `Apply action for ${item.subject || "message"}`);
      checkbox.addEventListener("change", updateSelection);
      checkCell.append(checkbox);
    }

    const statusCell = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = `status-chip ${item.status}`;
    chip.textContent = item.destinationName || item.status;
    statusCell.append(chip);

    const date = item.date ? new Date(item.date).toLocaleString() : "";
    row.append(
      checkCell,
      cell(date),
      cell(item.sourceFolderName || "(unknown)"),
      cell(item.recipients ? `${item.author}\nTo/Cc/Bcc: ${item.recipients}` : item.author, "address"),
      cell(item.subject || "(no subject)", "subject"),
      statusCell,
      cell(item.reason, "reason")
    );
    elements.tableBody.append(row);
  }
}

function renderAddresses() {
  elements.table.classList.add("hidden");
  elements.addressList.classList.remove("hidden");
  elements.selectAll.classList.add("hidden");
  elements.selectNone.classList.add("hidden");
  elements.apply.classList.add("hidden");
  elements.copyAddresses.classList.remove("hidden");
  elements.selectionCount.textContent = `${plan.addresses.length} unique address${plan.addresses.length === 1 ? "" : "es"}`;
  elements.addressList.replaceChildren();
  if (!plan.addresses.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No email addresses were found in this folder's message headers.";
    elements.addressList.append(empty);
    elements.copyAddresses.disabled = true;
    return;
  }
  for (const entry of plan.addresses) {
    const row = document.createElement("div");
    row.className = "address-row";
    const address = document.createElement("code");
    address.textContent = entry.address;
    const count = document.createElement("span");
    count.className = "muted";
    count.textContent = `${entry.count} message${entry.count === 1 ? "" : "s"}`;
    row.append(address, count);
    elements.addressList.append(row);
  }
}

function selectedIds() {
  return [...elements.tableBody.querySelectorAll('input[type="checkbox"]:checked')]
    .map(checkbox => checkbox.dataset.itemId);
}

function setRowInputsDisabled(disabled) {
  for (const checkbox of elements.tableBody.querySelectorAll('input[type="checkbox"]')) {
    if (!checkbox.dataset.completed) checkbox.disabled = disabled;
  }
}

function updateBatchControls() {
  const state = scanState();
  if (!state.isBulk || state.scanComplete) {
    elements.nextBatch.classList.add("hidden");
    return;
  }
  const ready = remainingActionCount();
  const mayContinue = ready === 0 || batchApplied;
  elements.nextBatch.classList.toggle("hidden", !mayContinue);
  elements.nextBatch.disabled = operationBusy;
  elements.nextBatch.textContent = `Preview batch ${state.batchNumber + 1}`;
}

function updateSelection() {
  const selected = selectedIds().length;
  const ready = remainingActionCount();
  const readyDetails = plan?.bulk
    ? ` · ${ready} ready in this batch`
    : "";
  elements.selectionCount.textContent = `${selected} action${selected === 1 ? "" : "s"} selected${readyDetails}`;
  elements.apply.disabled = operationBusy || selected === 0;
  updateBatchControls();
}

function selectAll(checked) {
  for (const checkbox of elements.tableBody.querySelectorAll('input[type="checkbox"]')) {
    if (!checkbox.disabled) checkbox.checked = checked;
  }
  updateSelection();
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
}

function setOperationBusy(busy) {
  operationBusy = busy;
  elements.selectAll.disabled = busy;
  elements.selectNone.disabled = busy;
  setRowInputsDisabled(busy);
  updateSelection();
}

function markResultRows(result) {
  for (const entry of result.results) {
    const row = [...elements.tableBody.rows].find(candidate => candidate.dataset.itemId === entry.itemId);
    const checkbox = row?.querySelector('input[type="checkbox"]');
    const item = plan.items.find(candidate => candidate.id === entry.itemId);
    const chip = row?.querySelector(".status-chip");
    if (checkbox) checkbox.checked = false;

    if (entry.status === "completed") {
      completedItemIds.add(entry.itemId);
      failedItemIds.delete(entry.itemId);
      if (checkbox) {
        checkbox.dataset.completed = "true";
        checkbox.disabled = true;
      }
      if (row) row.classList.add("completed");
      if (chip) {
        const destination = item?.destinationName?.replace(/ \(will be created on Apply\)$/u, "");
        chip.className = "status-chip completed";
        chip.textContent = destination ? `Moved to ${destination}` : "Moved";
      }
      if (row?.lastElementChild) row.lastElementChild.textContent = "Completed";
    } else {
      failedItemIds.add(entry.itemId);
      if (chip) {
        chip.className = "status-chip failed";
        chip.textContent = "Failed";
      }
      if (row?.lastElementChild && entry.error) row.lastElementChild.textContent = entry.error;
    }
  }
}

function resultMessage(result) {
  const ready = remainingActionCount();
  const state = scanState();
  const failures = result.results.filter(entry => entry.error);
  const failureDetails = failures.length
    ? `\n${failures.slice(0, 5).map(entry => `• ${entry.error}`).join("\n")}${failures.length > 5 ? `\n• ${failures.length - 5} more failures` : ""}`
    : "";
  let message = result.failed
    ? `${result.completed} completed; ${result.failed} failed.${failureDetails}`
    : `${result.completed} action${result.completed === 1 ? "" : "s"} completed.`;

  if (state.isBulk) {
    if (state.scanComplete && ready === 0) {
      message += " Entire Inbox processing is complete.";
    } else if (!state.scanComplete && ready === 0) {
      message += ` Preview batch ${state.batchNumber + 1} to continue.`;
    } else if (ready) {
      message += ` ${ready} ready action${ready === 1 ? "" : "s"} remain in this batch.`;
    }
  }
  return message;
}

async function applySelected() {
  const ids = selectedIds();
  if (!ids.length) return;
  const verb = plan.kind === "archive" ? "archive" : "move";
  const foldersToCreate = new Set(
    plan.items
      .filter(item => ids.includes(item.id) && item.action === "move" && !item.destinationExists)
      .map(item => item.destinationName.replace(/ \(will be created on Apply\)$/u, ""))
  );
  const folderNotice = foldersToCreate.size
    ? `\n\n${foldersToCreate.size} missing destination folder${foldersToCreate.size === 1 ? "" : "s"} will be created:\n${[...foldersToCreate].map(name => `• ${name}`).join("\n")}`
    : "";
  const archiveNotice = plan.kind === "archive"
    ? `\n\nArchive scope: ${plan.description}. Exactly ${ids.length} selected message${ids.length === 1 ? "" : "s"} will be moved to the configured dedicated archive folder.`
    : "";
  const confirmed = window.confirm(
    `Apply ${ids.length} action${ids.length === 1 ? "" : "s"}? This will ${verb} the selected messages.${archiveNotice}${folderNotice}`
  );
  if (!confirmed) return;

  setOperationBusy(true);
  elements.progress.classList.remove("hidden");
  elements.progressBar.max = Math.max(1, ids.length);
  elements.progressBar.value = 0;
  elements.progressText.textContent = `${plan.kind === "archive" ? "Archiving" : "Moving"} 0 of ${ids.length}…`;
  elements.result.classList.add("hidden");
  elements.error.classList.add("hidden");
  try {
    const result = await send("applyPlan", {planId: plan.id, selectedItemIds: ids});
    elements.progressBar.max = Math.max(1, result.attempted);
    elements.progressBar.value = result.attempted;
    elements.progressText.textContent = `${plan.kind === "archive" ? "Archived" : "Moved"} ${result.completed} of ${result.attempted}`;
    markResultRows(result);
    batchApplied = true;
    renderSummary();
    renderScanNotice();
    const remaining = remainingActionCount();
    elements.result.className = `banner ${result.failed || remaining ? "warning" : "success"}`;
    elements.result.textContent = resultMessage(result);
    elements.result.classList.remove("hidden");
    elements.progress.classList.add("hidden");
  } catch (error) {
    elements.progress.classList.add("hidden");
    showError(error.message);
  } finally {
    setOperationBusy(false);
  }
}

async function createNextBatch() {
  const ready = remainingActionCount();
  if (ready) {
    const failed = failedItemIds.size;
    const failureText = failed
      ? ` ${failed} of them failed during Apply.`
      : "";
    const confirmed = window.confirm(
      `${ready} ready action${ready === 1 ? "" : "s"} in this batch were not completed.${failureText} Continue anyway? They will remain in Inbox and may be left behind by this bulk run.`
    );
    if (!confirmed) return;
  }

  setOperationBusy(true);
  elements.result.className = "banner info";
  elements.result.textContent = "Building the next read-only batch…";
  elements.result.classList.remove("hidden");
  elements.error.classList.add("hidden");
  try {
    const response = await send("createNextBulkPlan", {planId: plan.id});
    if (!response?.planId) {
      throw new Error("The next batch could not be created. Start a new entire-Inbox run from Settings.");
    }
    location.replace(
      messenger.runtime.getURL(`organizer/organizer.html?plan=${encodeURIComponent(response.planId)}`)
    );
  } catch (error) {
    showError(error.message);
    elements.result.classList.add("hidden");
    setOperationBusy(false);
  }
}

messenger.runtime.onMessage.addListener(message => {
  if (message?.dmo && message.event === "progress" && message.planId === plan?.id) {
    elements.progress.classList.remove("hidden");
    elements.progressBar.max = Math.max(1, message.total);
    elements.progressBar.value = message.completed;
    elements.progressText.textContent = `${plan.kind === "archive" ? "Archiving" : "Moving"} ${message.completed} of ${message.total}…`;
  }
});

elements.selectAll.addEventListener("click", () => selectAll(true));
elements.selectNone.addEventListener("click", () => selectAll(false));
elements.apply.addEventListener("click", applySelected);
elements.nextBatch.addEventListener("click", createNextBatch);
elements.copyAddresses.addEventListener("click", async () => {
  const text = plan.addresses.map(entry => entry.address).join(";");
  try {
    await navigator.clipboard.writeText(text);
    elements.result.className = "banner success";
    elements.result.textContent = "Semicolon-separated address list copied.";
    elements.result.classList.remove("hidden");
  } catch {
    elements.result.className = "banner warning";
    elements.result.textContent = "Clipboard access was unavailable. Select and copy the addresses below.";
    elements.result.classList.remove("hidden");
  }
});
elements.settings.addEventListener("click", () => send("openSettings"));

try {
  if (!planId) throw new Error("No preview was specified.");
  plan = await send("getPlan", {planId});
  const state = scanState();
  const visibleTitle = state.isBulk
    ? `Process entire Inbox — Batch ${state.batchNumber}`
    : plan.title;
  document.title = `${visibleTitle} — Domain Mail Organizer`;
  elements.title.textContent = visibleTitle;
  elements.description.textContent = plan.description;
  elements.loading.classList.add("hidden");
  elements.content.classList.remove("hidden");
  renderSummary();
  renderScanNotice();
  if (plan.kind === "addresses") {
    renderAddresses();
  } else {
    renderItems();
    updateSelection();
  }
} catch (error) {
  elements.loading.classList.add("hidden");
  showError(error.message);
}
