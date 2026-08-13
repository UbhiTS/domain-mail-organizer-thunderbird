# Privacy

Domain Mail Organizer processes mail locally inside Thunderbird.

- It does not send message data, rules, account data, or telemetry to an
  external service.
- It requests Thunderbird access to account folders and message headers so it
  can preview and perform user-approved moves.
- **Save & set up folders** creates one uniquely named local address book per
  enabled account. After an enabled automatic Inbox move,
  the extension can add customer-owned addresses found in that message's From,
  To, Cc, and Bcc headers to the account's managed book. If the user explicitly
  selects internal domains for that account, the same headers can also add
  coworkers at the exact domains individually shown and approved in Settings. Those domains
  are derived from the account's configured Thunderbird identities; for
  `ubhi@google.com`, the proposed exact domain is `google.com`.
- Contact capture uses exact configured customer domains/email addresses and
  exact approved internal domains. It excludes all of the account's own
  identities and never reads a message body to discover contacts. It does not
  treat subdomains as internal. Before adding an address, it reads the user's
  address books to check for an exact normalized-email duplicate. It does not
  update, merge, or delete existing contacts.
- Settings also provides a user-triggered existing-mail backfill. It reads only
  the From, To, Cc, and Bcc headers from all dates in the enabled account's
  configured direct customer folders and their subfolders, while excluding
  unrelated sibling folders, and adds the same customer-owned and explicitly
  approved internal addresses to the already-set-up managed book. It does not read message
  bodies, move or modify messages, or create, rename, or delete mail folders.
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
- Optional body matching reads message text locally and is disabled by
  default.
- Settings, automatic-filing state, and safety journals are stored in the
  extension's local Thunderbird storage.
- Removing the extension through Thunderbird removes its extension-managed
  state according to Thunderbird's storage lifecycle. Folders, messages, local
  address books, and contacts already created or moved remain user-owned data
  in Thunderbird. Disabling automatic filing likewise does not remove contacts.

The extension itself makes no host or network requests. Thunderbird and the
configured mail provider continue to perform their normal synchronization.
