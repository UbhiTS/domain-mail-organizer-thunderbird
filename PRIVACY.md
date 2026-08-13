# Privacy

Domain Mail Organizer processes mail locally inside Thunderbird.

- It does not send message data, rules, account data, or telemetry to an
  external service.
- It requests Thunderbird access to account folders and message headers so it
  can preview and perform user-approved moves.
- **Save & set up folders** creates one uniquely named local address book per
  enabled account. After an enabled automatic Inbox move,
  the extension can add customer-owned addresses found in that message's From,
  To, Cc, and Bcc headers to the account's managed book.
- Contact capture uses only exact configured customer domains and email
  addresses, excludes the account's own identities, and never reads a message
  body to discover contacts. Before adding an address, it reads the user's
  address books to check for an exact normalized-email duplicate. It does not
  update, merge, or delete existing contacts.
- Settings also provides a user-triggered existing-mail backfill. It reads only
  the From, To, Cc, and Bcc headers from all dates in the enabled account's
  configured direct customer folders and their subfolders, while excluding
  unrelated sibling folders, and adds the same exact customer-owned
  addresses to the already-set-up managed book. It does not read message
  bodies, move or modify messages, or create, rename, or delete mail folders.
  The scan exhausts all message-list pages without a message-count cap and may
  take time for large or remote folders. Exact global deduplication makes a
  completed or interrupted scan safe to run again.
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
