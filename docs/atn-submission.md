# Thunderbird Add-ons submission notes

Use this checklist when submitting version 0.1.8 to addons.thunderbird.net
(ATN).

## Validation screen

- A result that says **validated with no errors** can continue.
- Select **Thunderbird** only. Do not select SeaMonkey.
- The generic validator may warn about these Thunderbird-only permissions:
  `accountsRead`, `accountsFolders`, `messagesRead`, and `messagesMove`. They are
  required by the extension and must not be removed.
- Open **See full validation report** and confirm that no additional warning
  category is present.

## Version notes

Paste the following into **Version notes**:

> Initial public release of Domain Mail Organizer for Thunderbird 140 ESR and
> newer. Includes exact sender and recipient domain matching, exact-address
> rules, optional subject/body keyword matching for reviewed manual actions,
> read-only previews, explicit Apply confirmation, multi-account customer
> folder trees, existing-folder adoption and rule import, a resumable
> entire-Inbox workflow, dedicated organizer archive/recovery, starred-message
> protection, address reports, and optional automatic Inbox filing with durable
> reconciliation and move-safety journaling. Domain rules are exact:
> shutterfly.com does not include em.shutterfly.com unless that subdomain is
> configured separately. The extension has no telemetry, advertising, remote
> code, external service, or host/network permission.

## Notes for reviewers

Paste the following into **Notes for Reviewers**:

> Domain Mail Organizer is a Thunderbird 140+ Manifest V3 MailExtension. No
> website account, subscription, payment, API key, test username, or test
> password is required by the add-on. It operates only on accounts already
> configured in the reviewer's Thunderbird test profile.
>
> Source repository and tag:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/tree/v0.1.8
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
> Output: artifacts/domain-mail-organizer-0.1.8.xpi and .zip.
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
>    set up folders.
> 4. Preview Inbox or selected test messages. Preview itself creates/moves
>    nothing; select Apply to perform proposed moves.
> 5. Verify person@example.com matches and person@mail.example.com remains
>    unmatched unless mail.example.com is explicitly configured.
> 6. Automatic filing remains unavailable until the account-local customer root
>    is explicitly set up.
>
> All processing is local. The extension makes no host/network requests and
> transmits no mailbox data or telemetry. Privacy statement:
> https://github.com/UbhiTS/domain-mail-organizer-thunderbird/blob/v0.1.8/PRIVACY.md

## Source-code upload field

The submitted XPI contains readable, unminified source and does not transform
the runtime code, so a separate source upload is generally unnecessary. If ATN
requests one, use the repository tag archive—not the installable release ZIP:

https://github.com/UbhiTS/domain-mail-organizer-thunderbird/archive/refs/tags/v0.1.8.zip

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
