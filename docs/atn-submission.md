# Thunderbird Add-ons submission notes

Use this checklist when submitting version 0.1.13 to addons.thunderbird.net
(ATN).

Before pasting the reviewer links below, manually create/push the `v0.1.13` tag
or publish the corresponding GitHub Release so the source snapshot exists.

## Validation screen

- A result that says **validated with no errors** can continue.
- Select **Thunderbird** only. Do not select SeaMonkey.
- The generic validator may warn about these Thunderbird-only permissions:
  `accountsRead`, `accountsFolders`, `addressBooks`, `messagesRead`, and
  `messagesMove`. They are required by the extension and must not be removed.
- Open **See full validation report** and confirm that no additional warning
  category is present.
- The manifest declares `data_collection_permissions.required: ["none"]`
  because no user data is transmitted outside the add-on or local Thunderbird
  profile; all processing and storage described below remain local.

## Version notes

Paste the following into **Version notes**:

> Adds automatic customer-contact capture paired with automatic Inbox filing.
> New accounts default to `Domains` and `Archive`; setup safely reuses those
> exact ordinary folders or creates them when absent, and imports direct
> domain-named children as account-scoped rules. Automatic filing and eligible
> exact internal identity domains start selected but remain dormant until setup
> verifies the folder and contact-book destinations.
> Setup reuses exactly one same-name local writable address book per enabled
> mail account, preserving its existing contacts, or creates it when absent;
> ambiguous, remote, or read-only same-name matches fail without contact writes.
> after Thunderbird confirms an automatic destination move, exact rule-matching From/To/Cc/Bcc
> addresses are added there. Users may separately select exact domains derived
> from each mail account's Thunderbird identities; matching coworkers are then
> captured from the same customer-mail headers and tagged with that domain.
> The user's own identities and all unapproved/subdomain addresses remain
> excluded. Capture globally deduplicates exact email
> addresses, excludes the account's own identities, never scans message bodies,
> and never updates or deletes existing contacts.
> A user-triggered Settings action can build the managed address book from all
> existing mail in configured customer folders and their subfolders. It scans
> every paginated header regardless of date or count, changes no messages or
> folders, and is repeat-safe. The toolbar's read-only Customer Contacts List
> separately scans every date/page in the selected direct customer folder and
> lists all available From/To/Cc/Bcc addresses without body access or contact
> writes. Process entire Inbox and archive recovery now live in Settings;
> Process Inbox, Archive Mails, and Customer Contacts List remain in the popup.
> On a fresh install, the popup shows only Settings until configuration has
> first been saved for a current Thunderbird account.
> Routing is deterministic and stops at the first matching stage: From/To/Cc,
> optional subject, then optional body. Exact header addresses beat domains;
> subject/body domains beat keywords. Among equally specific matches, the first
> enabled applicable rule in the name-sorted Customer rules list wins. Messages
> with no match stay in Inbox for review or later archiving.
> This version also preserves exact domain
> behavior: shutterfly.com does not include em.shutterfly.com
> unless that subdomain is configured separately. All processing remains local,
> with no telemetry, advertising, remote code, external service, or host/network
> permission.
> Existing users upgrading from 0.1.8 must run Save & set up once to
> safely reuse or create the managed contact book. Their existing
> automatic-filing choice is preserved, and automation pauses safely until
> setup is complete.

## Notes for reviewers

Paste the following into **Notes for Reviewers**:

> Domain Mail Organizer is a Thunderbird 140+ Manifest V3 MailExtension. No
> website account, subscription, payment, API key, test username, or test
> password is required by the add-on. It operates only on accounts already
> configured in the reviewer's Thunderbird test profile.
>
> Source repository and tag:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/tree/v0.1.13
>
> All first-party packaged JavaScript, HTML, and CSS are readable source files.
> First-party code is not minified, transpiled, bundled, or obfuscated, and the
> add-on uses no eval, remote code, or runtime code download. The only generated
> distribution file is the exact, unmodified upstream `psl` third-party file
> identified below. The build script creates ZIP/XPI archives from extension/
> and adds LICENSE and NOTICE.
>
> Build instructions (Node.js 22 or 24; npm):
> 1. npm ci --ignore-scripts
> 2. npm run check
> 3. npm run build
> Output: artifacts/domain-mail-organizer-0.1.13.xpi and .zip.
>
> Third-party library: `psl` 1.15.0, vendored unmodified as
> extension/vendor/psl.mjs. The included file is the upstream generated
> distribution file at:
> https://github.com/lupomontero/psl/blob/v1.15.0/dist/psl.mjs
> SHA-256: 66463ab217d9ac57174eb89b100058b450588ce6c8da577e6bf41c074d6514b7
> The readable parser source and generated rule-data source for that exact
> tagged release are:
> https://github.com/lupomontero/psl/blob/v1.15.0/index.js
> https://github.com/lupomontero/psl/blob/v1.15.0/data/rules.js
> Complete tagged source:
> https://github.com/lupomontero/psl/tree/v1.15.0
> Package release metadata:
> https://www.npmjs.com/package/psl/v/1.15.0
> The parser's MIT license is extension/vendor/PSL-LICENSE.txt. Its embedded
> rule data is based on the Mozilla Public Suffix List, whose source and MPL 2.0
> notice are at:
> https://publicsuffix.org/list/public_suffix_list.dat
> No other third-party runtime code is included.
>
> Permission purposes:
> - accountsRead: enumerate the user's configured Thunderbird accounts and
>   folders.
> - accountsFolders: create only explicitly configured organizer folders.
> - addressBooks: find and validate one same-name local writable contacts book
>   per enabled account or create it when absent, check all address books for
>   exact-email duplicates, and add exact
>   customer-rule-matching or explicitly approved identity-domain header addresses
>   following confirmed automatic destination moves or the reviewer's explicit existing-mail
>   backfill request.
> - messagesRead: read message headers and optional locally fetched body text
>   for matching and previews.
> - messagesMove: perform reviewed Apply actions and enabled automatic filing.
> - storage: retain local configuration, review plans, and automatic safety
>   state.
> - menus: provide the selected-message context action.
> - alarms: run five-minute reconciliation for enabled automatic Inbox filing.
>
> Functional test:
> 1. Install in Thunderbird 140+ with a disposable mail account or test profile.
> 2. Open the toolbar popup. On this fresh profile, confirm that only branding
>    and Settings & customer rules are shown, then open Settings. After saving
>    the account settings, reopen the popup and confirm processing controls appear.
> 3. Before setup, create ordinary test folders `Domains`, `Archive`, and
>    `Domains/example.com`. Enable the test account and choose Save & set up.
>    Confirm the first two same-name folders are reused and the
>    direct `example.com` child is imported as a scoped exact-domain rule
>    (or that the same folders are created when absent). Before setup, create one
>    local writable `Customer Contacts — …` address book with the exact generated
>    name and a sentinel contact. Confirm setup reuses its ID and preserves the
>    sentinel instead of creating a duplicate. Multiple same-name books, or a
>    sole same-name remote/read-only book, must be refused without any write.
> 4. Choose Process Inbox or preview selected test messages. Preview itself creates/moves
>    nothing; select Apply to perform proposed moves.
> 5. Verify person@example.com matches and person@mail.example.com remains
>    unmatched unless mail.example.com is explicitly configured.
>    Configure two customers to match the same stage and confirm the first
>    name-sorted Customer rule wins when the matches are equally specific.
>    Confirm an exact address beats a header-domain match and an exact domain
>    beats a keyword in subject/body.
>    Also confirm precedence is From/To/Cc, optional subject, then optional
>    body, and that a message with no match stays in Inbox.
> 6. Automatic filing remains dormant until the account-local domain root and
>    managed contact book are verified by setup, even though the new-account
>    preference starts selected.
> 7. Enable automatic filing and receive a new person@example.com message.
>    After Thunderbird confirms its destination move, confirm the exact rule-matching From/To/Cc/Bcc
>    address is added once. Own identities, unconfigured subdomains, subject/body
>    addresses, and addresses already present in any address book are not added.
>    Previewed, manually applied, or externally moved messages do not add contacts.
>    Optionally enable internal capture for an organization-owned test identity
>    domain. Confirm an exact coworker address is added with that domain as ORG,
>    while the reviewer's own identity and subdomain/lookalike addresses are not.
> 8. Put existing messages in the configured direct customer folder and one of
>    its subfolders, then choose Build address books from existing mail in
>    Settings. Confirm it scans all dates/pages and adds exact rule-matching
>    From/To/Cc/Bcc addresses. With internal capture enabled for the test
>    identity domain, confirm an exact coworker is also added once with that
>    domain as ORG, while subdomain/lookalike and own-identity addresses are not
>    added
>    without reading bodies or changing messages/folders. Run it again and
>    confirm no exact-email duplicate is created.
> 9. Select a direct customer folder and choose Customer Contacts List in the
>    toolbar popup. Confirm messages across all dates/pages are read and all
>    available From/To/Cc/Bcc addresses are listed, including own or unrelated
>    addresses, without reading bodies or writing contacts.
> 10. Confirm Process entire Inbox and Recover from Archive appear under
>    Mailbox tools in Settings rather than in the toolbar popup.
>
> All processing is local. The extension makes no host/network requests and
> transmits no mailbox data or telemetry. It never updates, merges, or deletes
> existing contacts. Managed books and contacts remain user-owned after the
> feature is disabled or the extension is uninstalled. Privacy statement:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/blob/v0.1.13/PRIVACY.md

## Source-code upload field

The submitted XPI contains readable, untransformed first-party source. Its only
generated distribution file is the exact, unmodified third-party `psl` 1.15.0
file linked above, with the readable source for that tagged release also linked.
A separate source upload is therefore generally unnecessary. If ATN requests
one, use the repository tag archive—not the installable release ZIP:

https://github.com/UbhiTS/domain-mail-organizer-thunderbird/archive/refs/tags/v0.1.13.zip

The archive contains `package.json`, `package-lock.json`, the build script, and
all extension sources required to reproduce the XPI.

## Listing selections

- Application: Thunderbird only.
- License: MIT License.
- Requires payment/non-free service: No.
- Requires an add-on-specific website account: No.
- Data transmission: None.
- Privacy policy URL (recommended even though nothing is transmitted):
  https://github.com/UbhiTS/domain-mail-organizer-thunderbird/blob/main/PRIVACY.md
