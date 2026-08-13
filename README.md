# Thunderbird Domain Mail Organizer

[![Build](https://github.com/UbhiTS/domain-mail-organizer-thunderbird/actions/workflows/build.yml/badge.svg)](https://github.com/UbhiTS/domain-mail-organizer-thunderbird/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Thunderbird port of [Outlook Domain Mail Organizer](https://github.com/UbhiTS/outlook-domain-mail-organizer), built for people who work with several customer organizations at once.

The extension scans customer mail locally and proposes account-local moves based on:

1. Exact configured sender domain or an exact sender address.
2. Exact configured To, Cc, or Bcc recipient domain/address.
3. An exact configured customer domain in the subject.
4. A customer keyword in the subject.
5. An exact configured customer domain in the message body.
6. A customer keyword in the message body.

That is the original Outlook precedence, with one safety improvement: if a single stage matches more than one customer, the message is marked ambiguous instead of being moved to whichever folder happens to be enumerated first.

## What is included

- Thunderbird 140 ESR+ Manifest V3 MailExtension.
- Multiple-account support with a separate customer tree in each account.
- `1 Day`, `2 Days`, `7 Days`, `30 Days`, and `All` scan windows.
- Read-only previews for Inbox processing, organizer-archive recovery, and bulk Inbox staging.
- A resumable **Process entire Inbox** workflow for large existing Inboxes, including mail older than 30 days. It advances through safe review batches instead of repeating the same first batch.
- Preview rows are displayed newest first.
- Starred-message protection.
- Exact, boundary-safe domain matching alongside exact-address, subject, body, and keyword matching. A domain rule never includes its subdomains unless they are configured separately.
- A frequency-sorted address report for the selected customer folder, copied as a semicolon-separated list.
- Optional sender/recipient-only automatic filing for new Inbox mail after customer folders have been set up.
- Startup and five-minute full-Inbox reconciliation against a compact durable activation baseline, recovering ordinary arrivals omitted by Thunderbird's new-mail event.
- JSON settings import/export.
- Explicit adoption of an existing account-local customer root or organizer archive folder.
- Read-only import of an existing customer root's direct child folders into reviewed, account-scoped customer-rule drafts.
- Collapsible customer cards that open alphabetically sorted and collapsed; newly added customers stay expanded at the top until the page is reopened.
- A message-list context action for previewing selected messages.
- Explicitly selected Sent messages can be organized by recipient domain; Drafts, Outbox, Trash, Junk, and Templates remain excluded.
- No external service, telemetry, tracking, or network request.

## Install and try it

### Temporary development install

1. Install Thunderbird 140 ESR or newer.
2. Open **Add-ons and Themes**.
3. Select the gear menu, then **Debug Add-ons**.
4. Choose **Load Temporary Add-on**.
5. Select [`extension/manifest.json`](extension/manifest.json).

The temporary add-on remains installed until Thunderbird restarts.

### XPI package

The latest XPI and ZIP packages are available from [GitHub Releases](https://github.com/UbhiTS/domain-mail-organizer-thunderbird/releases/latest). To rebuild them locally:

```powershell
npm install
npm run check
npm run build
```

The XPI is unsigned. It can be used for local development/testing where Thunderbird permits unsigned add-ons; public distribution should go through [addons.thunderbird.net](https://addons.thunderbird.net/).

## First-time setup

1. Open **Domain Mail Organizer → Settings & customer rules**.
2. Enable the work account(s) you want the extension to use.
3. Keep `Customers` as the root folder name, or change it to the original `Domains` convention. If that exact direct folder already exists, select **Use an existing folder with this name**.
4. Keep `Organizer Archive` as the staging folder name, or choose another dedicated folder/label. Do not point this workflow at Gmail's `All Mail`.
5. To seed rules from an existing root, select **Import existing customer folders...**. Review the direct child folders in the dialog and choose **Add selected for review**. A folder whose complete name is a valid organization domain, such as `rail.hitachi.com`, gets that domain prefilled and can be enabled. Other names and exact-domain conflicts are imported as disabled drafts for you to complete.
6. Add or finish each customer:
   - Name: `Acme Corp`
   - Folder: `acme.com` or `Acme Corp`
   - Domains: `acme.com, acmecloud.io`
   - Optional exact addresses for shared providers such as Gmail.
   - Optional project/customer keywords.
7. Select **Save & set up folders**. Adoption consent is one-use and must exactly match the configured name.
8. Use the toolbar button to **Preview Inbox** for a normal date-window batch, or **Process entire Inbox** to scan all dates in resumable batches.
9. Review each proposed destination and deselect anything you do not want to move.
10. Select **Apply selected actions**.
11. After folder setup, we recommend testing one preview and Apply before optionally enabling automatic Inbox filing in Settings.

Installing or updating the extension does not create folders or move messages. Folder discovery/import is read-only and never inspects message contents.
Folder setup will not silently adopt an existing customer root or organizer archive. It reuses one only when you provide one-time exact-name approval in that account card. Existing customer destinations beneath an approved root are reused by their exact configured names.

## Outlook-to-Thunderbird mapping

| Outlook add-in | Thunderbird extension |
|---|---|
| `Domains/<domain>` folders | Configurable account-local `Customers/<customer>` folders |
| Folder Description stores comma-separated keywords | Keywords are stored in extension settings |
| Process Inbox | Read-only Inbox preview, then explicit Apply |
| Process Archive | Scans the dedicated account-local `Organizer Archive` folder |
| Archive Mails | Previews unstarred Inbox messages, then moves only the selected batch to `Organizer Archive` |
| List Emails | Reports addresses owned by the selected customer's exact domain/address rules |
| Flagged mail is protected | Starred mail is protected by default |
| Hidden MAPI property moves newest folder to top | No stable Thunderbird folder-order API; not emulated by renaming or moving folders |

Thunderbird does not expose Outlook's private folder-sort property, so “Newest to Top” cannot be ported safely. Thunderbird's built-in **Recent folders** mode is the closest native alternative.

The dedicated organizer archive is intentional. Thunderbird maps Gmail's native Archive to **All Mail**, which also contains Inbox, Sent, and labeled messages. A separate label keeps recovery scoped to mail this extension actually staged instead of treating nearly the entire Google Workspace mailbox as archived.

## Safety model

- Previews perform no folder creation, message move, archive, tag, or settings mutation.
- Apply re-fetches every message and reruns its customer classification.
- A preview becomes invalid after settings change.
- A message that moved after preview is skipped.
- Previewed organizer destinations are re-resolved and checked against their session ID before Apply; unapproved root/archive name collisions and folders that appear after preview fail closed.
- Existing-root import examines direct normal writable child folders only. It never recurses, reads messages, changes folders, or enables a rule inferred from a broad public suffix or an exact-domain conflict.
- Automatic filing requires an approved customer root from **Save & set up folders**, then safely creates a missing direct customer folder when its first matching message arrives.
- Automatic filing uses sender/recipient domain and exact-address rules only; subject and body inference remain preview-only.
- Enabling automatic filing first snapshots the complete current Inbox, so existing mail is not silently treated as a new arrival. New-mail event hints are persisted before filing work waits in a queue.
- Every automatic move is journaled to local storage before Thunderbird is asked to move it. A copied or failed outcome is held for manual review and is never blindly retried; an accepted move remains claimed until Inbox reconciliation proves it absent.
- Cross-account automatic moves are prohibited.
- Junk, external/file messages, and messages below Trash, Junk, Drafts, Templates, or Outbox are excluded.
- Message scans are paginated and work-bounded. A preview stores up to the configured limit (up to 1,000 rows), examines at most five times that limit (capped at 5,000 headers), prioritizes actionable messages over diagnostic rows, and can be narrowed or rerun after Apply.
- **Process entire Inbox** keeps session-local occurrence progress for every examined message. Select and Apply a reviewed batch, then choose **Preview batch N+1**. A 4,000-message Inbox with 4,000 matches is handled as four batches of up to 1,000 actions plus a final verification scan. A batch with only unmatched, ambiguous, or protected mail can still advance to later messages.
- Body text is capped at 500,000 characters per message during matching and is off by default.
- Domains are exact and boundary-safe: `shutterfly.com`, `em.shutterfly.com`, and `notshutterfly.com` are three different domains. A rule for `shutterfly.com` matches only that domain; mail from `em.shutterfly.com` stays unmatched unless that subdomain is configured separately.
- Sister companies and subdomains route independently. For example, configure `hitachi.com`, `hal.hitachi.com`, `rail.hitachi.com`, and `cyber.hitachi.com` explicitly for their respective customer folders.
- Domain rules must be organization-owned domains, not broad public suffixes such as `co.uk`.

The requested permissions are intentionally limited:

- `accountsRead`: discover the user's accounts and folders.
- `accountsFolders`: create explicitly configured customer folders.
- `messagesRead`: inspect headers, subject, and optionally body text.
- `messagesMove`: move matched messages between the account-local organizer folders.
- `storage`: save local rules, previews, and the last run summary.
- `menus`: add the selected-message preview action.
- `alarms`: wake the transient background page every five minutes to reconcile enabled automatic Inboxes.

The extension does **not** request delete, permanent message modification, native host, downloads, cookies, browsing, or host/network permissions.

## License and attribution

Copyright (c) 2026 Tarun Ubhi (UbhiTS).

This project is open source under the [MIT License](LICENSE). You may use,
modify, distribute, sublicense, and sell it, provided the copyright and license
notice is retained in copies or substantial portions of the software. See
[NOTICE](NOTICE) for attribution and [VENDOR.md](VENDOR.md) for the separately
licensed vendored dependency.

## Development

```powershell
npm install
npm test
npm run check:syntax
npm run lint
npm run build
```

`npm run lint` uses Mozilla's generic `web-ext` linter. It reports Thunderbird-only mail permissions as Firefox warnings; the Thunderbird 140 API contract and permissions must also be checked in Thunderbird itself. The build creates byte-identical `.xpi` and `.zip` archives with `manifest.json`, `LICENSE`, and `NOTICE` at the archive root.

GitHub Actions runs syntax checks, all tests, lint, and packaging on every push
and pull request. It uploads the XPI, ZIP, and SHA-256 checksums as workflow
artifacts. A `v*` tag whose version matches `package.json` and `manifest.json`
also publishes those files to a GitHub Release.

See [`docs/manual-test-plan.md`](docs/manual-test-plan.md) for the end-to-end Thunderbird checks.
For ATN listing and reviewer fields, use the paste-ready
[`docs/atn-submission.md`](docs/atn-submission.md) guide.

## Known limitations

- Final mailbox integration still needs to be exercised with a disposable real IMAP/Gmail and Local Folders account in Thunderbird; automated tests cover deterministic rule, pagination, folder-race, archive, and apply paths with API mocks.
- Thunderbird's query time window is based on the message date exposed by its API, whereas the Outlook add-in filtered `ReceivedTime`.
- Message and folder IDs are session-scoped. Preview plans intentionally expire on Thunderbird/extension restart, and opening a newer preview replaces the prior preview plan.
- Entire-Inbox progress is also session-scoped. Finish the run before restarting/reloading Thunderbird; after a restart, start a new entire-Inbox run. Already moved messages are no longer in Inbox, so the fresh run safely evaluates what remains.
- Customer folders are direct children of the configured root in this version.
- Gmail exposes IMAP folders as labels. This extension therefore uses a dedicated `Organizer Archive` label rather than Gmail `All Mail`; real Google Workspace label behavior still needs the manual test plan.
- Automatic filing covers new Inbox messages only. Sent mail can be organized explicitly from the message-list context action; this release does not alter Thunderbird's normal send/FCC behavior.
- Automatic filing intentionally uses only sender/recipient headers. Late Thunderbird filters can still race with the new-mail event, so avoid overlapping automatic rules for the same customers.
- Thunderbird has an open defect in which an arrival event can occasionally be omitted. The extension therefore compares the full enabled Inbox with a compact durable multiset at startup and every five minutes, then processes at most 50 unseen candidates per pass. Event-observed mail remains eligible even with an old Date header. A scan-only old-dated discovery is left in Inbox and reported for review because Thunderbird 140 cannot distinguish delayed new mail from previously unsynchronized history.
- Thunderbird may briefly increment the Inbox badge before an automatic move finishes, and folder-count notifications can be collapsed by Thunderbird. The extension never uses badge counts as proof of a move.
- Automatic filing applies each move once and does not blindly retry. The move journal is written before the API call, and the move-event broker has no fixed wall-clock deadline that could misclassify a slow IMAP operation. Verify the automatic workflow with a disposable Google Workspace mailbox before relying on it for production mail.
- If Thunderbird reports a copy or an automatic move fails after invocation, that message is persistently held from later reconciliation and shown in the toolbar popup. A move accepted before its delayed event arrives remains journaled and is escalated for review if reconciliation still finds it in Inbox.
- There is no stable API equivalent for forcing the most recently active customer folder to the top.

## Repository note

The original public Outlook repository contains an unrelated PDF under `OutlookDomainMailOrganizer/images/Internet (Nov).pdf`. It appears to contain personal account information and is unused by the add-in. It was not copied into this project; remove it from the original repository and its Git history before further sharing.
