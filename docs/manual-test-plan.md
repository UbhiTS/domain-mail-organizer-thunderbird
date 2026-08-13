# Manual Thunderbird test plan

Run these checks on Thunderbird 140 ESR or newer with a disposable profile and test messages. Never begin integration testing against the only copy of important mail.

## 1. Installation and permission review

- Load `extension/manifest.json` as a temporary add-on.
- Confirm the background console has no startup errors.
- Confirm the add-on requests account/folder read, folder creation, address-book read/write, message read/move, storage, menu, and alarm access only.
- Confirm installation creates no folders or address books, adds no contacts, and moves no messages.
- Confirm the toolbar button opens the popup and Settings opens in a tab.

## 2. Settings validation

- Confirm Local Folders is not listed; enable one disposable IMAP account.
- Add `Acme` with `acme.com`, an exact address, and a keyword.
- Verify invalid folder names containing `/` or `\\` are rejected.
- Verify duplicate exact domains in overlapping account scopes are rejected.
- Verify two customers cannot share the same folder in the same account.
- Export settings, change a value, import the JSON, and save it.
- Import a configuration scoped to an unavailable account and confirm it is rejected instead of silently becoming global.
- Open two Settings tabs, save different changes from both, and confirm every older preview is invalidated.
- For a new account, confirm automatic filing and every eligible exact identity domain are selected by default. Uncheck one domain and automatic filing, save, and confirm those opt-outs persist. Re-enable only `@google.com` for `ubhi@google.com`; confirm shared consumer-mail domains show a warning. Confirm an imported internal domain that is not one of the account's identity domains is rejected.

## 3. Folder setup

- Run **Save & set up**.
- Confirm the configured `Domains` root, dedicated `Archive`, one direct child per active customer, and one uniquely named `Customer Contacts — …` local address book are created for each enabled account.
- On an account with a provider special-use Archive already named `Archive`, confirm setup refuses to repurpose it and clearly asks for a different ordinary archive-folder name.
- Run setup a second time and confirm no duplicate folders are created.
- Confirm the second setup also reuses the extension's managed address-book ID and creates no duplicate address book.
- Before first setup, create an unrelated address book with the exact proposed `Customer Contacts — …` name. Confirm setup fails safely instead of adopting, clearing, or overwriting it. Rename/delete the test collision, rerun setup, and confirm the managed book is created.
- Before first setup, create ordinary exact-name `Domains` and `Archive` folders. Confirm setup validates/reuses them without duplicates and preserves their contents.
- Put direct children named `acme.com`, `Rail.Hitachi.com`, and `Acme Projects` below `Domains`, then run setup. Confirm direct normal writable children are imported automatically as rules.
- Confirm domain-shaped folders become enabled, account-scoped exact-domain rules. Confirm `Acme Projects` becomes a disabled draft and an exact domain already owned by another active rule imports disabled with a warning.
- Change either configured root/archive name and save. Confirm automatic filing pauses until setup validates/reuses or creates the replacement exact folder.
- Disable an account and confirm setup does not alter it.
- With a verified domain root, delete a test customer's direct child folder, enable automatic filing, and confirm the first matching message recreates that exact configured child and moves into it.
- Delete or rename the verified domain root and confirm automatic filing leaves matching mail in Inbox and reports that folder setup is required.

## 4. Match precedence and preview

Create test mail so each case is isolated:

- Sender `person@acme.com` → Acme.
- Internal sender with To/Cc `person@acme.com` → Acme.
- Internal participants with `acme.com` only in subject → Acme.
- Customer keyword only in subject → Acme.
- Exact configured domain only in quoted body → Acme.
- Keyword only in quoted body → Acme.
- `person@notacme.com` → unmatched.
- `person@sub.acme.com` → unmatched when only `acme.com` is configured.
- Configure `shutterfly.com` only; confirm `person@shutterfly.com` matches Shutterfly while `person@em.shutterfly.com` remains unmatched in Inbox.
- Add `em.shutterfly.com` explicitly and confirm it now follows only the customer rule that owns that exact subdomain.
- Configure separate `hitachi.com`, `hal.hitachi.com`, `rail.hitachi.com`, and `cyber.hitachi.com` customers; confirm each exact domain lands in its own customer folder without inheriting or falling back to another rule.
- A message matching recipients from two customers → ambiguous and not selected.
- A starred matching message → protected/skipped.
- A selected message inside a child of Trash/Junk/Drafts/Templates/Outbox → skipped.

Preview the 1-, 2-, 7-, and 30-day windows and All. Confirm no message moves during preview.

## 5. Apply and stale-plan safety

- Deselect one proposed move and Apply; confirm only checked rows move.
- Move a previewed message manually before Apply; confirm it fails as “moved after preview.”
- Star a previewed message before Apply; confirm it is protected.
- Change Settings after preview; confirm the old plan is rejected.
- Confirm customer moves remain inside the source account.
- Confirm one failed row does not stop unrelated selected rows.

## 6. Archive workflows

- Choose **Archive Mails** in the toolbar popup with starred and unstarred Inbox mail.
- Confirm starred mail is excluded.
- Apply and confirm selected messages move to the dedicated Archive folder/label.
- Add a customer rule after archiving a matching message.
- In Settings under **Mailbox tools**, run **Recover from Archive** and confirm the staged message can be recovered into its customer folder.
- On Gmail/Google Workspace, confirm the recovery scan uses the dedicated label and never scans Gmail All Mail, Sent, Inbox, or an existing customer label as archive input.

## 7. Customer Contacts List

- Select a direct customer folder in the active mail tab.
- Run **Customer Contacts List** from the toolbar popup.
- Confirm it scans all dates and all message-list pages in that exact folder even when the configured preview window is 7 or 30 days and the folder contains more messages than the preview limit.
- Confirm every valid normalized From, To, Cc, and Bcc address appears, including the account's own identities, unrelated domains, and unconfigured subdomains. Bcc is best-effort because received messages may not expose it.
- Confirm nested customer subfolders are not included and no message body is fetched.
- Confirm addresses are ordered by descending message frequency.
- Copy and paste the semicolon-separated result into a text editor.
- Select a non-customer folder and confirm the report refuses to guess.

## 8. Automatic Inbox filing

- Complete folder setup; first verify one preview and Apply as the recommended smoke test.
- Enable auto-file for a test account.
- Before enabling, leave matching historical mail in Inbox; confirm activation snapshots it and does not retroactively move it.
- Receive matching and nonmatching messages.
- Confirm only an unstarred, non-junk, unambiguous matching Inbox message moves.
- With only `shutterfly.com` configured, receive mail from `em.shutterfly.com`; confirm it remains in Inbox and does not increment the Shutterfly customer folder.
- Confirm a message matching only by subject or body remains in Inbox; unattended filing is sender/recipient-only.
- Delete a customer destination under the verified domain root, receive matching mail, and confirm the configured direct child is recreated before the message moves.
- Receive a multi-page burst larger than the preview limit and confirm automatic filing considers every message in the event instead of dropping the tail.
- Receive a matching message while another organizer operation is running; confirm the arrival list is drained and the message is rechecked before it moves.
- Temporarily disable the live new-mail listener in a development build, leave a matching message in Inbox, and confirm the startup/five-minute reconciliation moves it using the same rules.
- Repeat with a recent message already marked Read/New=false and confirm full-Inbox reconciliation still discovers it.
- With the listener enabled, receive an old-dated message and interrupt filing after its event hint is stored; confirm reconciliation still considers it. With the event deliberately omitted, confirm an old-dated scan-only discovery is reported for review and left in Inbox.
- Watch Inbox and destination unread badges during a move. Temporary flicker is acceptable; verify the actual message location rather than treating badge timing as the result.
- Add a Thunderbird filter that moves the same message after junk classification; confirm no duplicates are created. Late filters and the extension can race, so do not configure overlapping automatic rules in production.
- Force or simulate a copy event and a move with no confirmation; confirm the Inbox message is held for manual review and is not automatically attempted again.

## 9. Automatic customer contacts

- Complete **Save & set up**, enable automatic filing, and receive a message that automatically moves to a customer folder. Confirm customer-owned addresses from its From, To, Cc, and Bcc headers are added to that account's managed `Customer Contacts — …` book only after Thunderbird confirms the destination move. Simulate an API-accepted move without an observed destination event and confirm it creates no contacts and remains in safety review.
- Put several customer-owned addresses in one message and confirm each unique normalized address is added once, using the normalized email address as its visible contact name rather than the unauthenticated header display name.
- Include the enabled account's own primary address and aliases/identities in the headers; confirm none of those addresses are added.
- Enable internal capture for an account with identity `ubhi@google.com`. In one automatically moved customer message include `coworker@google.com`, `person@mail.google.com`, and `person@notgoogle.com`; confirm only `coworker@google.com` is added as internal with `ORG:google.com`. The account's own identities must still be excluded.
- Disable internal capture and repeat with a new `@google.com` address; confirm it is not added. For a personal-provider test identity such as `person@gmail.com`, confirm it starts selected for a new account, displays the shared-provider warning, and can be deliberately unchecked before setup.
- With only `shutterfly.com` configured, include both `person@shutterfly.com` and `person@em.shutterfly.com`; confirm only the exact configured-domain address is added. Then configure the subdomain for a separate customer and confirm it is captured only for that customer's automatic move.
- Configure one exact shared-provider address, such as `customer.contact@gmail.com`, alongside an unrelated Gmail address; confirm only the configured exact address is added.
- Pre-create the same normalized email address in the managed book, then in a different Thunderbird address book. In both cases, confirm a later automatic move creates no duplicate anywhere.
- Put a customer-looking email address only in the subject or body and confirm it is never harvested as a contact, even when body matching is enabled for previews.
- Preview or Apply a reviewed move, manually move a message, and copy a message into a customer folder with another tool. Confirm none of those actions adds a contact.
- Delete the managed address book, then receive matching mail. Confirm automatic filing and contact capture pause together, the message stays in Inbox, and setup is requested. Run setup successfully, re-enable automation, and confirm later matched mail moves and captures contacts again.
- Disable automatic filing and confirm existing contacts remain. In a disposable profile, uninstall the extension and confirm its address book and contacts remain ordinary user-owned Thunderbird data.

## 10. Existing-mail customer-contact backfill

- Complete **Save & set up**, place historical messages across two configured direct customer folders, and choose **Build address books from existing mail** in Settings. Confirm progress identifies the current account/folder and increases through every page.
- Include messages older than 30 days and more than 1,000 messages total (4,000 is the target scale case). Confirm the action exhausts all pages and has no date, preview-limit, or message-count cutoff.
- Confirm only enabled customers applicable to the enabled account are scanned. A configured customer's nested folders must be included, while disabled customers, customers scoped to another account, and unrelated sibling folders beneath or outside the domain root must not contribute contacts.
- Include exact-domain, configured exact-address, unconfigured-subdomain, and account-identity addresses in From, To, Cc, and Bcc. Confirm only exact customer-owned, non-identity addresses are added to the customer attribution represented by their configured folder.
- With internal capture approved for `google.com`, place the same coworker on messages in several customer folders. Confirm the single existing-mail scan creates that employee once with `ORG:google.com`, does not attribute the employee to either customer, and performs no second message scan.
- Put customer-looking addresses only in subject/body text and instrument `listInlineTextParts`; confirm no body is fetched. Instrument message move and folder create/update/delete APIs; confirm none is called.
- Remove one configured customer folder and confirm it is skipped and reported without creating it. Then delete or rename the verified domain root and confirm the scan fails closed before reading customer messages or adding contacts.
- Put the same normalized address in multiple historical messages and customer folders, and pre-create another candidate in a different Thunderbird address book. Confirm the global address-book inventory is read once, each exact email is created at most once, and attribution is deterministic when the same candidate appears under multiple customers.
- Simulate one contact-create failure between two successes. Confirm creation is sequential, later candidates continue, progress/final totals report the partial failure, and no messages or folders change.
- Run the completed backfill again. Confirm every prior contact is reported as existing and no duplicate is created. Interrupt a large run, start it again, and confirm already-created contacts remain deduplicated.

## 11. Scale, restart, and packaging

- Set the preview limit to 25 and scan a folder with more than 25 messages; confirm the truncation banner appears.
- Scan more than one Thunderbird message-list page and confirm all pages up to the limit are processed.
- Put more than 25 protected/unmatched messages before a matching message and confirm the later actionable message is still offered.
- With the limit at 25, put the next match beyond 125 messages and confirm the preview stops at its explicit 125-message work budget instead of scanning the whole mailbox.
- Seed an Inbox with 4,000 matching messages, set the limit to 1,000, and choose **Process entire Inbox** in Settings under **Mailbox tools**. Confirm four reviewed Apply batches move all 4,000, followed by a fifth read-only verification batch reporting the scan complete.
- Seed more than one scan budget of protected/unmatched messages before a match. Confirm **Preview batch N+1** advances past the earlier occurrences and eventually offers the later match even though nothing in the first batch moved.
- Confirm a completed scan with sampled non-actionable rows says that all messages were examined; it must not claim that the scan safety limit stopped the query.
- Leave selected actions unapplied and choose the next batch. Confirm the warning explains they will remain in Inbox and be deferred for this run; cancel once, then explicitly accept and verify later mail is reachable.
- Restart Thunderbird during an entire-Inbox run; confirm its session progress expires and a new run safely evaluates the messages still in Inbox.
- Restart Thunderbird with a preview open; confirm it expires rather than reusing transient message IDs.
- Build the XPI and verify `manifest.json` is at the archive root.
- Load the XPI in the disposable profile and repeat the onboarding → preview → apply smoke test.
