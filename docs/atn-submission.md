# Thunderbird Add-ons submission notes

Use this checklist when submitting version 0.1.9 to addons.thunderbird.net
(ATN).

Before pasting the reviewer links below, manually create/push the `v0.1.9` tag
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
  because the extension does not collect or transmit user data.

## Version notes

Paste the following into **Version notes**:

> Adds automatic customer-contact capture paired with automatic Inbox filing.
> Folder setup creates one managed local address book per enabled mail account;
> after an accepted automatic move, exact customer-owned From/To/Cc/Bcc
> addresses are added there. Capture globally deduplicates exact email
> addresses, excludes the account's own identities, never scans message bodies,
> and never updates or deletes existing contacts. This version also preserves
> exact domain behavior: shutterfly.com does not include em.shutterfly.com
> unless that subdomain is configured separately. All processing remains local,
> with no telemetry, advertising, remote code, external service, or host/network
> permission.
> Existing users upgrading from 0.1.8 must run Save & set up folders once to
> create the managed contact book, then re-enable automatic filing. Automation
> pauses safely until that explicit setup is complete.

## Notes for reviewers

Paste the following into **Notes for Reviewers**:

> Domain Mail Organizer is a Thunderbird 140+ Manifest V3 MailExtension. No
> website account, subscription, payment, API key, test username, or test
> password is required by the add-on. It operates only on accounts already
> configured in the reviewer's Thunderbird test profile.
>
> Source repository and tag:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/tree/v0.1.9
>
> The packaged JavaScript, HTML, and CSS are readable source files. There is no
> minification, transpilation, bundling, obfuscation, eval, remote code, or
> runtime code download. The build script only creates deterministic ZIP/XPI
> archives from extension/ and adds LICENSE and NOTICE.
>
> Reproducible build (Node.js 22 or 24; npm):
> 1. npm ci --ignore-scripts
> 2. npm run check
> 3. npm run build
> Output: artifacts/domain-mail-organizer-0.1.9.xpi and .zip.
>
> Third-party library: psl 1.15.0, vendored unmodified as
> extension/vendor/psl.mjs. Source:
> https://www.npmjs.com/package/psl/v/1.15.0
> Its MIT license is extension/vendor/PSL-LICENSE.txt and provenance is in
> VENDOR.md. No other third-party runtime code is included.
>
> Permission purposes:
> - accountsRead: enumerate the user's configured Thunderbird accounts and
>   folders.
> - accountsFolders: create only explicitly configured organizer folders.
> - addressBooks: create one managed local customer-contact book per enabled
>   account, check all address books for exact-email duplicates, and add exact
>   customer-owned header addresses following accepted automatic moves.
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
> 2. Open the toolbar popup, then Settings & customer rules.
> 3. Enable a test account, add a customer with example.com, and choose Save &
>    set up folders. Confirm a uniquely named local `Customer Contacts — …` address book
>    is also created; an unrelated exact-name collision is refused rather than
>    adopted or overwritten.
> 4. Preview Inbox or selected test messages. Preview itself creates/moves
>    nothing; select Apply to perform proposed moves.
> 5. Verify person@example.com matches and person@mail.example.com remains
>    unmatched unless mail.example.com is explicitly configured.
> 6. Automatic filing remains unavailable until the account-local customer root
>    is explicitly set up.
> 7. Enable automatic filing and receive a new person@example.com message.
>    After its accepted move, confirm the exact customer-owned From/To/Cc/Bcc
>    address is added once. Own identities, unconfigured subdomains, subject/body
>    addresses, and addresses already present in any address book are not added.
>    Previewed, manually applied, or externally moved messages do not add contacts.
>
> All processing is local. The extension makes no host/network requests and
> transmits no mailbox data or telemetry. It never updates, merges, or deletes
> existing contacts. Managed books and contacts remain user-owned after the
> feature is disabled or the extension is uninstalled. Privacy statement:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/blob/v0.1.9/PRIVACY.md

## Source-code upload field

The submitted XPI contains readable, unminified source and does not transform
the runtime code, so a separate source upload is generally unnecessary. If ATN
requests one, use the repository tag archive—not the installable release ZIP:

https://github.com/UbhiTS/domain-mail-organizer-thunderbird/archive/refs/tags/v0.1.9.zip

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
