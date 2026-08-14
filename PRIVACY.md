# Privacy

Domain Mail Organizer processes mail locally inside Thunderbird.

- It does not send message data, rules, account data, or telemetry to an
  external service.
- It requests Thunderbird access to account folders and message headers so it
  can preview and perform user-approved moves.
- **Save & set up** assigns one uniquely named local writable address book per
  enabled account. If no book has the generated name, setup creates it. If
  exactly one same-name local writable address book exists, setup validates and
  reuses its ID. Every contact already in a reused book is preserved. Multiple
  same-name books are treated as ambiguous, and a remote or read-only same-name
  book is refused; those failures create no replacement book and write no
  contacts. After Thunderbird confirms an enabled automatic Inbox move reached
  its destination,
  the extension can add customer-rule-matching addresses found in that
  message's From, To, Cc, and Bcc headers to the account's managed book. If the
  user selects internal domains for that account, the same headers
  can also add coworkers at the exact domains individually shown and approved
  in Settings.
  Those domains are derived from the account's configured Thunderbird
  identities; for `ubhi@google.com`, the proposed exact domain is `google.com`.
- If Thunderbird accepts a move request without confirming the destination,
  the safety journal retains it for reconciliation and no contacts are created
  from that message.
- Contact capture uses exact configured customer domains/email addresses and
  exact approved internal domains. It excludes all of the account's own
  identities and never reads a message body to discover contacts. It does not
  treat subdomains as internal. Before adding an address, it reads the user's
  address books to check for an exact normalized-email duplicate. It does not
  update, merge, or delete existing contacts. A new contact uses the normalized
  email address as both its address and visible name; unauthenticated display
  names supplied in message headers are never written to the address book.
- Email header addresses and display names are assertions supplied with each
  message. The extension does not independently authenticate them. A customer
  folder placement or managed contact is therefore not proof of sender identity;
  Thunderbird and the configured mail provider remain responsible for their
  normal spam, phishing, and authentication checks.
- Settings also provides a user-triggered existing-mail backfill. It reads only
  the From, To, Cc, and Bcc headers from all dates in the enabled account's
  configured direct customer folders and their subfolders, while excluding
  unrelated sibling folders, and adds the same customer-rule-matching and
  explicitly approved internal addresses to the already-set-up managed book.
  It does not read message bodies, move or modify messages, or create, rename,
  or delete mail folders.
  The scan exhausts all message-list pages without a message-count cap and may
  take time for large or remote folders. Exact global deduplication makes a
  completed or interrupted scan safe to run again.
- The toolbar popup's read-only **Customer Contacts List** scans every message
  header across all dates and pages in the currently selected direct customer
  folder. It displays every available normalized From, To, Cc, and Bcc address,
  including the account's own identities and addresses outside configured
  customer domains. It does not scan subfolders, read message bodies, modify
  messages, or write to any address book.
- If the managed address book is deleted, renamed, or becomes read-only,
  automatic filing and contact capture pause together until setup is repaired.
  While a stored address-book ID still resolves, it remains authoritative;
  renaming that book does not make the extension silently select another book.
- Optional body matching asks Thunderbird for message text and is disabled by
  default. For a remote mailbox, that request may cause Thunderbird and the
  configured provider to perform their normal IMAP content fetch; the extension
  does not send the content elsewhere.
- Customer routing stops at the first matching stage: From/To/Cc, optional
  subject, then optional body. Exact header addresses take priority over
  domains, and subject/body domains take priority over keywords. Among equally
  specific matches, the first enabled applicable customer in the name-sorted
  order saved from Settings wins. A message with no match remains in Inbox.
- Preview and review plans are held in the extension's Thunderbird session
  storage. A mail-action plan can include message and Message-ID identifiers,
  date, author, displayed recipients, subject, size, source account/folder,
  match result, and destination. A Customer Contacts List plan can include the
  normalized addresses and occurrence counts found by that report. The current
  plan remains until it is replaced, Settings saves a configuration, or the
  Thunderbird extension session ends; it is not written to durable local
  storage. While an entire-Inbox run is active, the same session storage also
  holds the exact Thunderbird message identifiers already examined in that
  run; those identifiers expire with the extension session and are never used
  by themselves as authority to move mail.
- Settings, managed address-book destination references, the latest run summary,
  automatic-filing state, and safety journals are stored in the extension's
  local Thunderbird storage. Automatic filing keeps compact Inbox
  baseline fingerprints, occurrence counts, arrival hints, and manual-review
  entries. A manual-review entry for an old-dated message includes its author,
  subject, reason, creation time, and count and can remain while the matching
  message remains in the Inbox.
- Export settings creates a local JSON file containing the extension
  configuration, including account identifiers and customer rules; it contains
  no message contents. Import settings reads only the file the user selects.
  Neither operation uploads the file.
- The automatic-move safety journal can contain the mail account identifier,
  message fingerprints, matched customer identifier, destination folder name,
  Message-ID header, author, subject, move state or review reason, and
  timestamps. After reconciliation observes that a journaled message has been
  absent from the Inbox for at least 24 hours, that move entry is removed.
  Entries requiring manual review can remain while the corresponding message
  remains in the Inbox or until automatic reconciliation resolves them.
- There is currently no in-product command that clears individual safety or
  manual-review entries. They are removed by the reconciliation behavior above
  or when Thunderbird clears the extension's local storage, including on
  uninstall according to Thunderbird's storage lifecycle.
- Removing the extension through Thunderbird removes its extension-managed
  state according to Thunderbird's storage lifecycle. Folders, messages, local
  address books (whether created or reused by setup), and contacts already
  created or moved remain user-owned data in Thunderbird. Disabling automatic
  filing likewise does not remove contacts.

The extension itself makes no host or network requests. Thunderbird and the
configured mail and address-book providers continue to perform their normal
fetching and synchronization.
