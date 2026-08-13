// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {SOURCE_LABELS, SPECIAL_SOURCE_TYPES} from "./constants.js";
import {customerById} from "./config.js";
import {
  discoverCustomerFolders,
  findSpecialFolder,
  folderHasSpecialUse,
  folderOrAncestorHasSpecialUse,
  folderIsInside,
  getAccount,
  resolveCustomerFolder,
  resolveCustomerRoot,
  resolveOrganizerArchive
} from "./folders.js";
import {
  displayRecipients,
  getMessageBody,
  iterateMessageList,
  messageAccountId,
  messageAddressData,
  messageFolderId,
  parseMailboxValues,
  queryFolderMessages
} from "./mail.js";
import {messageFingerprint} from "./fingerprint.js";
import {classifyMessage} from "./rules.js";

function planId() {
  return globalThis.crypto?.randomUUID?.() ?? `plan-${Date.now()}-${Math.random()}`;
}

function compactHeader(header) {
  const clipped = (value, maximum) => String(value ?? "").slice(0, maximum);
  return {
    messageId: header.id,
    headerMessageId: clipped(header.headerMessageId, 320),
    date: header.date instanceof Date ? header.date.toISOString() : String(header.date ?? ""),
    author: clipped(header.author, 320),
    recipients: clipped(displayRecipients(header), 500),
    subject: clipped(header.subject, 320),
    size: Number.isFinite(header.size) ? header.size : null,
    sourceFolderId: messageFolderId(header),
    sourceFolderName: clipped(header.folder?.name, 120),
    accountId: messageAccountId(header)
  };
}

function summarizeItems(items) {
  const summary = {
    total: items.length,
    actionable: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    skipped: 0
  };
  for (const item of items) {
    if (item.action) {
      summary.actionable += 1;
    }
    if (Object.hasOwn(summary, item.status)) {
      summary[item.status] += 1;
    }
  }
  return summary;
}

function createPlanRecorder(limit) {
  const items = [];
  const summary = summarizeItems([]);
  let sampled = false;

  function record(item) {
    summary.total += 1;
    if (item.action) {
      summary.actionable += 1;
    }
    if (Object.hasOwn(summary, item.status)) {
      summary[item.status] += 1;
    }

    if (item.action && items.length >= limit) {
      const replaceIndex = items.findIndex(candidate => !candidate.action);
      if (replaceIndex >= 0) {
        items.splice(replaceIndex, 1);
        sampled = true;
      }
    }
    if (items.length < limit) {
      items.push(item);
    } else {
      sampled = true;
    }
  }

  return {
    items,
    summary,
    record,
    get sampled() {
      return sampled;
    }
  };
}

function scanBudget(limit) {
  return Math.max(limit, Math.min(5_000, limit * 5));
}

function positiveCountMap(raw = {}) {
  const counts = new Map();
  for (const [fingerprint, value] of Object.entries(raw ?? {})) {
    const count = Math.floor(Number(value));
    if (fingerprint && Number.isFinite(count) && count > 0) {
      counts.set(fingerprint, count);
    }
  }
  return counts;
}

function incrementObjectCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function consumeCount(counts, key) {
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

async function classifyHeader(header, config, accountId, api, options = {}) {
  const addresses = await messageAddressData(header, api);
  const input = {
    ...addresses,
    subject: header.subject ?? ""
  };

  const effectiveConfig = options.allowSubject === false
    ? {...config, scanSubject: false}
    : config;
  let classification = classifyMessage(input, effectiveConfig, accountId);
  if (classification.status === "unmatched" && config.scanBody && options.allowBody !== false) {
    if (header.headersOnly) {
      classification.bodyWarning = "Body is not available for this header-only message";
      return classification;
    }
    try {
      input.body = await getMessageBody(header.id, api);
      if (!input.body) {
        classification.bodyWarning = "Body was empty or unavailable and was not matched";
        return classification;
      }
      classification = classifyMessage(input, effectiveConfig, accountId);
    } catch (error) {
      classification.bodyWarning = `Body could not be read: ${error.message}`;
    }
  }
  return classification;
}

async function getSourceFolder(account, accountConfig, source, api) {
  if (source === "inbox") {
    const inbox = findSpecialFolder(account, "inbox");
    if (!inbox) {
      throw new Error(`No Inbox was found for “${account.name}”.`);
    }
    return {folder: inbox, includeSubFolders: false};
  }
  if (source === "archive") {
    const archive = await resolveOrganizerArchive(account, accountConfig, false, api);
    if (!archive) {
      throw new Error(
        `No organizer archive folder was found for “${account.name}”. Run folder setup first.`
      );
    }
    return {folder: archive, includeSubFolders: false};
  }
  throw new Error(`Unsupported scan source: ${source}`);
}

export async function buildOrganizePlan(request, config, api = messenger) {
  const account = await getAccount(request.accountId, api);
  const accountConfig = config.accounts?.[account.id];
  if (!accountConfig?.enabled) {
    throw new Error("Enable the selected account in Domain Mail Organizer settings first.");
  }

  let messageList;
  let sourceDescription;
  if (request.messageList) {
    messageList = request.messageList;
    sourceDescription = SOURCE_LABELS.selection;
  } else {
    const source = await getSourceFolder(account, accountConfig, request.source, api);
    messageList = queryFolderMessages(
      source.folder,
      request.days,
      source.includeSubFolders,
      api,
      Math.min(100, config.maxMessagesPerRun)
    );
    sourceDescription = SOURCE_LABELS[request.source] ?? request.source;
  }

  const automatic = Boolean(request.automatic);
  const customerRoot = await resolveCustomerRoot(account, accountConfig, false, api);
  if (automatic && accountConfig.customerRootReady && !customerRoot) {
    throw new Error(
      "The approved customer root is missing. Run Save & set up folders before automatic filing resumes."
    );
  }
  // An automatic Inbox move has no dependency on the optional organizer
  // archive. A partial archive setup must not block otherwise valid customer
  // filing.
  const organizerArchive = automatic || (request.source === "inbox" && !request.messageList)
    ? null
    : await resolveOrganizerArchive(account, accountConfig, false, api);
  const recorder = createPlanRecorder(automatic ? Number.POSITIVE_INFINITY : config.maxMessagesPerRun);
  const destinations = new Map();
  const sourceCapabilities = new Map();
  const sourceSafety = new Map();
  const sourceInsideCustomerTree = new Map();
  const maximumScanned = automatic
    ? Number.POSITIVE_INFINITY
    : scanBudget(config.maxMessagesPerRun);
  const bulk = !automatic && request.bulk ? request.bulk : null;
  const previouslyExamined = positiveCountMap(bulk?.examinedCounts);
  const bulkExaminedCounts = {};

  let stopReason = null;
  let scanned = 0;
  for await (const header of iterateMessageList(messageList, api)) {
    const fingerprint = bulk ? messageFingerprint(header) : null;
    if (bulk && consumeCount(previouslyExamined, fingerprint)) {
      continue;
    }
    if (scanned >= maximumScanned) {
      stopReason = "scan-budget";
      break;
    }
    if (bulk) incrementObjectCount(bulkExaminedCounts, fingerprint);
    scanned += 1;
    const base = compactHeader(header);
    if (messageAccountId(header) && messageAccountId(header) !== account.id) {
      recorder.record({...base, status: "skipped", reason: "Message belongs to another account"});
      continue;
    }
    if (header.external) {
      recorder.record({...base, status: "skipped", reason: "External messages cannot be moved"});
      continue;
    }
    const sourceId = messageFolderId(header);
    if (!sourceId) {
      recorder.record({...base, status: "skipped", reason: "Message has no movable source folder"});
      continue;
    }
    if (sourceId && !sourceCapabilities.has(sourceId)) {
      sourceCapabilities.set(sourceId, await api.folders.getFolderCapabilities(sourceId));
    }
    if (sourceCapabilities.get(sourceId)?.canDeleteMessages === false) {
      recorder.record({...base, status: "skipped", reason: "Source is read-only; moving would only create a copy"});
      continue;
    }
    if (request.messageList && sourceId && !sourceSafety.has(sourceId)) {
      sourceSafety.set(
        sourceId,
        await folderOrAncestorHasSpecialUse(header.folder, SPECIAL_SOURCE_TYPES, api)
      );
    }
    if (request.messageList && sourceSafety.get(sourceId)) {
      recorder.record({...base, status: "skipped", reason: "This special-use source folder is excluded"});
      continue;
    }
    if (header.junk) {
      recorder.record({...base, status: "skipped", reason: "Junk mail is excluded"});
      continue;
    }
    if (config.preserveFlagged && header.flagged) {
      recorder.record({...base, status: "skipped", reason: "Starred message is protected"});
      continue;
    }
    if (customerRoot && sourceId && !sourceInsideCustomerTree.has(sourceId)) {
      sourceInsideCustomerTree.set(
        sourceId,
        await folderIsInside(header.folder, customerRoot, api)
      );
    }
    if (customerRoot && sourceInsideCustomerTree.get(sourceId)) {
      recorder.record({...base, status: "skipped", reason: "Already inside the customer folder tree"});
      continue;
    }
    if (request.source !== "archive" && organizerArchive?.id === sourceId) {
      recorder.record({...base, status: "skipped", reason: "Already inside the organizer archive"});
      continue;
    }

    const classification = await classifyHeader(header, config, account.id, api, {
      allowBody: !request.automatic,
      allowSubject: !request.automatic
    });
    if (classification.status === "matched") {
      const customer = customerById(config, classification.customerId);
      if (!automatic && !destinations.has(customer.id)) {
        destinations.set(
          customer.id,
          await resolveCustomerFolder(account, accountConfig, customer, false, api)
        );
      }
      // Automatic jobs resolve their destination while applying each item.
      // That keeps one unavailable customer folder from aborting unrelated
      // customers in the same new-mail event, and permits a configured missing
      // child folder to be created under the approved customer root.
      const destination = automatic ? null : destinations.get(customer.id);
      const destinationExists = automatic ? null : Boolean(destination);
      recorder.record({
        ...base,
        id: `${header.id}:${classification.customerId}`,
        status: "matched",
        action: "move",
        customerId: customer.id,
        customerName: customer.name,
        destinationName: `${accountConfig.rootFolderName} / ${customer.folderName}${destinationExists === false ? " (will be created on Apply)" : ""}`,
        destinationExists,
        destinationFolderId: destination?.id ?? null,
        customerRootFolderId: customerRoot?.id ?? null,
        reason: classification.reason
      });
      if (!automatic && recorder.summary.actionable >= config.maxMessagesPerRun) {
        stopReason = "action-limit";
        break;
      }
    } else {
      const bodyWarning = classification.bodyWarning
        ? `; ${classification.bodyWarning}`
        : "";
      recorder.record({
        ...base,
        id: `${header.id}:${classification.status}`,
        status: classification.status,
        reason: `${classification.reason}${bodyWarning}`
      });
    }
  }

  const title = request.messageList
    ? `Organize ${sourceDescription}`
    : request.source === "inbox"
      ? "Process Inbox"
      : request.source === "archive"
        ? "Recover from Organizer Archive"
        : `Organize ${sourceDescription}`;

  return {
    id: planId(),
    kind: "organize",
    createdAt: new Date().toISOString(),
    configRevision: config.revision,
    accountId: account.id,
    accountName: account.name,
    title,
    description: `${account.name} · ${Number(request.days) > 0 ? `${request.days} day window` : "all mail"}`,
    request: request.messageList ? null : {
      kind: "organize",
      source: request.source,
      accountId: request.accountId,
      days: Number(request.days) || 0
    },
    scanComplete: stopReason === null,
    stopReason,
    rowsSampled: recorder.sampled,
    truncated: stopReason !== null || recorder.sampled,
    scanned,
    scanBudget: maximumScanned,
    ...(bulk ? {bulkExaminedCounts} : {}),
    items: recorder.items,
    summary: recorder.summary
  };
}

export async function buildArchivePlan(request, config, api = messenger) {
  const account = await getAccount(request.accountId, api);
  const accountConfig = config.accounts?.[account.id];
  if (!accountConfig?.enabled) {
    throw new Error("Enable the selected account in settings first.");
  }
  const inbox = findSpecialFolder(account, "inbox");
  if (!inbox) {
    throw new Error(`No Inbox was found for “${account.name}”.`);
  }
  const archive = await resolveOrganizerArchive(account, accountConfig, false, api);
  if (!archive) {
    throw new Error(
      `No organizer archive folder was found for “${account.name}”. Run folder setup first.`
    );
  }
  const inboxCapabilities = await api.folders.getFolderCapabilities(inbox.id);
  if (inboxCapabilities?.canDeleteMessages === false) {
    throw new Error("The Inbox is read-only; archiving would only create copies.");
  }
  const recorder = createPlanRecorder(config.maxMessagesPerRun);
  const messageList = queryFolderMessages(
    inbox,
    request.days,
    false,
    api,
    Math.min(100, config.maxMessagesPerRun)
  );
  const maximumScanned = scanBudget(config.maxMessagesPerRun);
  let stopReason = null;
  let scanned = 0;
  for await (const header of iterateMessageList(messageList, api)) {
    if (scanned >= maximumScanned) {
      stopReason = "scan-budget";
      break;
    }
    scanned += 1;
    const base = compactHeader(header);
    if (header.external || header.junk) {
      recorder.record({...base, id: `${header.id}:skipped`, status: "skipped", reason: "Junk or external message is excluded"});
      continue;
    }
    if (config.preserveFlagged && header.flagged) {
      recorder.record({...base, id: `${header.id}:flagged`, status: "skipped", reason: "Starred message is protected"});
      continue;
    }
    recorder.record({
      ...base,
      id: `${header.id}:archive`,
      status: "matched",
      action: "archive",
      destinationName: accountConfig.archiveFolderName,
      destinationFolderId: archive.id,
      reason: "Unstarred Inbox message"
    });
    if (recorder.summary.actionable >= config.maxMessagesPerRun) {
      stopReason = "action-limit";
      break;
    }
  }

  return {
    id: planId(),
    kind: "archive",
    createdAt: new Date().toISOString(),
    configRevision: config.revision,
    accountId: account.id,
    accountName: account.name,
    title: "Archive Mails",
    description: `${account.name} · ${Number(request.days) > 0 ? `${request.days} day window` : "all mail"}`,
    request: {
      kind: "archive",
      source: "inbox",
      accountId: request.accountId,
      days: Number(request.days) || 0
    },
    scanComplete: stopReason === null,
    stopReason,
    rowsSampled: recorder.sampled,
    truncated: stopReason !== null || recorder.sampled,
    scanned,
    scanBudget: maximumScanned,
    items: recorder.items,
    summary: recorder.summary
  };
}

async function resolveCurrentMailFolder(api) {
  const tabs = await api.mailTabs.query({active: true, lastFocusedWindow: true});
  return tabs.find(tab => tab.displayedFolder)?.displayedFolder ?? null;
}

export async function buildAddressReport(request, config, api = messenger) {
  const folder = await resolveCurrentMailFolder(api);
  if (!folder) {
    throw new Error("Select a customer folder in a Thunderbird mail tab first.");
  }
  const account = await getAccount(folder.accountId, api);
  if (request.accountId && account.id !== request.accountId) {
    throw new Error(
      `The active folder belongs to “${account.name}”, not the account selected in Domain Mail Organizer.`
    );
  }
  const accountConfig = config.accounts?.[account.id];
  const discovered = accountConfig
    ? await discoverCustomerFolders(account, accountConfig, api)
    : [];
  const isCustomerFolder = discovered.some(candidate => candidate.id === folder.id);
  if (!isCustomerFolder) {
    throw new Error(`“${folder.name}” is not a direct customer folder.`);
  }

  const counts = new Map();
  let scanned = 0;

  // This is an exhaustive, read-only report for the selected folder itself.
  // Deliberately omit fromDate and any preview limit, then consume every page.
  const messageList = queryFolderMessages(folder, 0, false, api, 100);
  for await (const header of iterateMessageList(messageList, api)) {
    scanned += 1;
    if (messageAccountId(header) && messageAccountId(header) !== account.id) {
      continue;
    }
    const addresses = await parseMailboxValues(
      [header.author, ...(header.recipients ?? []), ...(header.ccList ?? []), ...(header.bccList ?? [])],
      api
    );
    for (const address of addresses) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  const addresses = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([address, count]) => ({address, count}));

  return {
    id: planId(),
    kind: "addresses",
    createdAt: new Date().toISOString(),
    configRevision: config.revision,
    accountId: account.id,
    accountName: account.name,
    title: `Customer Contacts List — ${account.name} / ${folder.name}`,
    description: `${addresses.length} unique address${addresses.length === 1 ? "" : "es"} · ${scanned} messages scanned`,
    scanComplete: true,
    scanned,
    truncated: false,
    addresses,
    summary: {total: addresses.length, actionable: 0, matched: addresses.length, ambiguous: 0, unmatched: 0, skipped: 0}
  };
}

export async function applyPlan(
  plan,
  selectedItemIds,
  config,
  notify,
  api = messenger,
  options = {}
) {
  if (plan.configRevision !== config.revision) {
    throw new Error("Settings changed after this preview. Create a fresh preview before applying it.");
  }
  if (!["organize", "archive"].includes(plan.kind)) {
    throw new Error("This report has no actions to apply.");
  }

  const selected = new Set(selectedItemIds);
  const actionable = plan.items.filter(item => item.action && selected.has(item.id));
  const account = await getAccount(plan.accountId, api);
  const accountConfig = config.accounts?.[account.id];
  if (!accountConfig?.enabled) {
    throw new Error("The account is no longer enabled.");
  }

  const results = [];
  const folderCache = new Map();
  const sourceCapabilities = new Map();
  const sourceSafety = new Map();
  let archiveDestination = null;
  let rootCreatedByApply = null;
  const customerRootWasReady = accountConfig.customerRootReady;
  let customerRootStatePersisted = customerRootWasReady;
  for (const [index, item] of actionable.entries()) {
    const progress = {planId: plan.id, completed: index, total: actionable.length};
    await notify?.(progress);
    let destinationFolderId = item.destinationFolderId ?? null;
    let moveAttempted = false;
    try {
      const header = await api.messages.get(item.messageId);
      if (messageFolderId(header) !== item.sourceFolderId) {
        throw new Error("Message moved after the preview");
      }
      if (options.requireInboxSource && !folderHasSpecialUse(header.folder, "inbox")) {
        throw new Error("Message is no longer in the Inbox");
      }
      if (header.external || header.junk) {
        throw new Error("Message is now external or marked as junk");
      }
      if (!sourceCapabilities.has(item.sourceFolderId)) {
        sourceCapabilities.set(
          item.sourceFolderId,
          await api.folders.getFolderCapabilities(item.sourceFolderId)
        );
      }
      const canDeleteMessages = sourceCapabilities.get(item.sourceFolderId)?.canDeleteMessages;
      if (
        canDeleteMessages === false ||
        (options.requireDefiniteMove && canDeleteMessages !== true)
      ) {
        throw new Error("Source is now read-only; moving would only create a copy");
      }
      if (config.preserveFlagged && header.flagged) {
        throw new Error("Message is now starred and protected");
      }

      if (!sourceSafety.has(item.sourceFolderId)) {
        sourceSafety.set(
          item.sourceFolderId,
          await folderOrAncestorHasSpecialUse(header.folder, SPECIAL_SOURCE_TYPES, api)
        );
      }
      if (sourceSafety.get(item.sourceFolderId)) {
        throw new Error("Message is now in an excluded special-use folder");
      }

      if (item.action === "archive") {
        if (!folderHasSpecialUse(header.folder, "inbox")) {
          throw new Error("Message is no longer in the Inbox");
        }
        if (!archiveDestination) {
          archiveDestination = await resolveOrganizerArchive(
            account,
            accountConfig,
            false,
            api
          );
        }
        if (!archiveDestination || archiveDestination.id !== item.destinationFolderId) {
          throw new Error("Organizer archive folder changed after the preview");
        }
        destinationFolderId = archiveDestination.id;
        moveAttempted = true;
        await api.messages.move([header.id], archiveDestination.id, {
          isUserAction: options.isUserAction !== false
        });
      } else {
        const classification = await classifyHeader(header, config, account.id, api, {
          allowBody: options.allowBody !== false,
          allowSubject: options.allowSubject !== false
        });
        if (
          classification.status !== "matched" ||
          classification.customerId !== item.customerId
        ) {
          throw new Error("Message no longer matches the previewed customer");
        }
        const customer = customerById(config, item.customerId);
        if (!customer) {
          throw new Error("Customer rule no longer exists");
        }
        let destination = options.liveDestinations ? null : folderCache.get(customer.id);
        if (!destination) {
          if (options.liveDestinations) {
            destination = await resolveCustomerFolder(
              account,
              accountConfig,
              customer,
              options.createFolders !== false,
              api,
              null,
              item.customerRootFolderId
            );
          } else {
            if (!item.destinationExists && options.createFolders === false) {
              throw new Error("Destination folder is missing; run folder setup first");
            }
            destination = await resolveCustomerFolder(
              account,
              accountConfig,
              customer,
              item.destinationExists ? false : options.createFolders !== false,
              api,
              item.destinationFolderId,
              rootCreatedByApply?.id ?? item.customerRootFolderId,
              !item.destinationExists
            );
          }
          if (!destination) {
            throw new Error("Destination folder is missing; run folder setup first");
          }
          if (!customerRootStatePersisted && accountConfig.customerRootReady) {
            await options.persistConfigState?.(config);
            customerRootStatePersisted = true;
          }
          if (item.customerRootFolderId === null && !rootCreatedByApply) {
            rootCreatedByApply = await resolveCustomerRoot(
              account,
              accountConfig,
              false,
              api
            );
          }
          if (!options.liveDestinations) {
            folderCache.set(customer.id, destination);
          }
        }
        if (destination.accountId !== account.id) {
          throw new Error("Cross-account moves are not allowed");
        }
        destinationFolderId = destination.id;
        moveAttempted = true;
        const moveOperation = () => api.messages.move([header.id], destination.id, {
          isUserAction: options.isUserAction !== false
        });
        if (options.confirmMove) {
          await options.confirmMove(
            {
              messageId: header.id,
              sourceFolderId: item.sourceFolderId,
              destinationFolderId: destination.id,
              item
            },
            moveOperation
          );
        } else {
          await moveOperation();
        }
      }
      results.push({
        itemId: item.id,
        status: "completed",
        destinationFolderId,
        moveAttempted
      });
    } catch (error) {
      results.push({
        itemId: item.id,
        status: "failed",
        error: error.message,
        destinationFolderId,
        moveAttempted,
        moveIndeterminate: Boolean(error.automaticMoveIndeterminate)
      });
    }
  }
  await notify?.({planId: plan.id, completed: actionable.length, total: actionable.length});

  const completed = results.filter(result => result.status === "completed").length;
  return {
    attempted: actionable.length,
    completed,
    failed: results.length - completed,
    customerRootCreated: !customerRootWasReady && accountConfig.customerRootReady,
    results
  };
}
