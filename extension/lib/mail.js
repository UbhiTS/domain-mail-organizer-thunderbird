// Copyright (c) 2026 Tarun Ubhi (UbhiTS). Licensed under the MIT License.
// SPDX-License-Identifier: MIT
import {MAX_BODY_CHARACTERS} from "./constants.js";
import {fallbackParseMailboxString, normalizeEmail} from "./rules.js";

function flattenParsedMailbox(entries) {
  const emails = [];
  for (const entry of entries ?? []) {
    if (entry?.email) {
      const normalized = normalizeEmail(entry.email);
      if (normalized) {
        emails.push(normalized);
      }
    }
    if (entry?.group) {
      emails.push(...flattenParsedMailbox(entry.group));
    }
  }
  return emails;
}

export async function parseMailboxValues(values, api = messenger) {
  const strings = (Array.isArray(values) ? values : [values]).filter(
    value => typeof value === "string" && value
  );
  const emails = [];

  for (const value of strings) {
    try {
      const parsed = await api.messengerUtilities.parseMailboxString(value, false);
      emails.push(...flattenParsedMailbox(parsed));
    } catch {
      emails.push(...fallbackParseMailboxString(value));
    }
  }

  return [...new Set(emails)];
}

export async function messageAddressData(header, api = messenger) {
  const [authorEmails, recipientEmails] = await Promise.all([
    parseMailboxValues(header.author, api),
    parseMailboxValues(
      [
        ...(header.recipients ?? []),
        ...(header.ccList ?? []),
        ...(header.bccList ?? [])
      ],
      api
    )
  ]);
  return {authorEmails, recipientEmails};
}

export async function getMessageBody(messageId, api = messenger) {
  const parts = await api.messages.listInlineTextParts(messageId);
  let remaining = MAX_BODY_CHARACTERS;
  const chunks = [];

  // Prefer text/plain. HTML remains useful for literal customer domains and
  // keywords, and Thunderbird's converter removes tags when needed.
  const ordered = [...parts].sort((left, right) =>
    left.contentType === "text/plain" ? -1 : right.contentType === "text/plain" ? 1 : 0
  );

  for (const part of ordered) {
    if (remaining <= 0 || typeof part.content !== "string") {
      break;
    }
    let content = part.content;
    if (part.contentType === "text/html") {
      try {
        content = await api.messengerUtilities.convertToPlainText(content);
      } catch {
        // Literal matching against HTML is still safe and useful as a fallback.
      }
    }
    const chunk = content.slice(0, remaining);
    chunks.push(chunk);
    remaining -= chunk.length;
  }

  return chunks.join("\n");
}

export async function* iterateMessageList(firstPageOrPromise, api = messenger) {
  let page = await firstPageOrPromise;
  try {
    while (page) {
      for (const message of page.messages ?? []) {
        yield message;
      }
      if (!page.id) {
        page = null;
        break;
      }
      page = await api.messages.continueList(page.id);
    }
  } finally {
    if (page?.id) {
      await api.messages.abortList(page.id).catch(() => {});
    }
  }
}

export async function collectMessageList(firstPageOrPromise, limit, api = messenger) {
  const messages = [];
  let truncated = false;

  for await (const message of iterateMessageList(firstPageOrPromise, api)) {
    if (messages.length >= limit) {
      truncated = true;
      break;
    }
    messages.push(message);
  }

  return {messages, truncated};
}

export function queryFolderMessages(folder, days, includeSubFolders, api = messenger, pageSize = 100) {
  const query = {
    folderId: folder.id,
    includeSubFolders,
    messagesPerPage: pageSize,
    autoPaginationTimeout: 500
  };
  if (Number(days) > 0) {
    query.fromDate = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
  }
  return api.messages.query(query);
}

export async function collectFolderMessages(folder, days, limit, includeSubFolders, api = messenger) {
  return collectMessageList(
    queryFolderMessages(folder, days, includeSubFolders, api, Math.min(100, limit)),
    limit,
    api
  );
}

export function messageFolderId(header) {
  return header?.folder?.id ?? header?.folderId ?? null;
}

export function messageAccountId(header) {
  return header?.folder?.accountId ?? null;
}

export function displayRecipients(header) {
  return [
    ...(header.recipients ?? []),
    ...(header.ccList ?? []),
    ...(header.bccList ?? [])
  ].join(", ");
}
