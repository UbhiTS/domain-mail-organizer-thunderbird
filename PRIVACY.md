# Privacy

Domain Mail Organizer processes mail locally inside Thunderbird.

- It does not send message data, rules, account data, or telemetry to an
  external service.
- It requests Thunderbird access to account folders and message headers so it
  can preview and perform user-approved moves.
- Optional body matching reads message text locally and is disabled by
  default.
- Settings, automatic-filing state, and safety journals are stored in the
  extension's local Thunderbird storage.
- Removing the extension through Thunderbird removes its extension-managed
  state according to Thunderbird's storage lifecycle. Folders and messages
  already created or moved remain in the mailbox.

The extension itself makes no host or network requests. Thunderbird and the
configured mail provider continue to perform their normal synchronization.
