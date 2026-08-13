# Manual Thunderbird test plan

Run these checks on Thunderbird 140 ESR or newer with a disposable profile and test messages. Never begin integration testing against the only copy of important mail.

## 1. Installation and permission review

- Load `extension/manifest.json` as a temporary add-on.
- Confirm the background console has no startup errors.
- Confirm the add-on requests account/folder read, folder creation, address-book read/write, message read/move, storage, menu, and alarm access only.
- Confirm installation creates no folders or address books, adds no contacts, and moves no messages.
- Confirm the toolbar button opens the popup and Settings opens in a tab.

## 2. Settings validation

- Enable one IMAP account and one Local Folders account.
- Add `Acme` with `acme.com`, an exact address, and a keyword.
- Verify invalid folder names containing `/` or `\\` are rejected.
- Verify duplicate exact domains in overlapping account scopes are rejected.
- Verify two customers cannot share the same folder in the same account.
- Export settings, change a value, import the JSON, and save it.
- Import a configuration scoped to an unavailable account and confirm it is rejected instead of silently becoming global.
- Open two Settings tabs, save different changes from both, and confirm every older preview is invalidated.

## 3. Folder setup

- Run **Save & set up folders**.
- Confirm the configured customer root, dedicated Organizer Archive, one direct child per active customer, and one uniquely named `Customer Contacts — …` local address book are created for each enabled account.
- Run setup a second time and confirm no duplicate folders are created.
- Confirm the second setup also reuses the extension's managed address-book ID and creates no duplicate address book.
- Before first setup, create an unrelated address book with the exact proposed `Customer Contacts — …` name. Confirm setup fails safely instead of adopting, clearing, or overwriting it. Rename/delete the test collision, rerun setup, and confirm the managed book is created.
- Before first setup, create an ordinary folder using the proposed Organizer Archive name; confirm setup refuses to adopt it without one-time approval. Approve the exact name and confirm setup adopts it without creating a duplicate. Confirm its existing contents are unchanged, then verify recovery treats them as organizer-archive input.
- Repeat with the proposed customer root name. Confirm setup refuses the unapproved collision, then approve the exact name and confirm it is adopted without creating a duplicate.
- Put direct child folders named `acme.com`, `Rail.Hitachi.com`, and `Acme Projects` below that existing root. Select **Import existing customer folders...** and confirm only direct normal writable children are offered; nested, special-use, virtual, and read-only folders are excluded.
- Confirm domain-shaped folders prefill enabled, account-scoped domain rules. Confirm `Acme Projects` is added as an expanded disabled draft until a matcher is supplied. Confirm a domain already owned by another active rule imports disabled with a warning.
- Confirm importing changes no folder or message. Save settings, reopen the page, and confirm the imported customers appear collapsed in customer-name order.
- Change either approved name, then confirm its ready state and automatic-filing control are invalidated until the replacement folder is set up or explicitly adopted.
- Disable an account and confirm setup does not alter it.
- With an approved customer root, delete a test customer's direct child folder, enable automatic filing, and confirm the first matching message recreates that exact configured child and moves into it.
- Disable or invalidate approval of the customer root and confirm automatic filing leaves matching mail in Inbox and reports that folder setup is required.

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

- Preview **Inbox → Organizer Archive** with starred and unstarred Inbox mail.
- Confirm starred mail is excluded.
- Apply and confirm selected messages move to the dedicated Organizer Archive folder/label.
- Add a customer rule after archiving a matching message.
- Run **Recover from Organizer Archive** and confirm the staged message can be recovered into its customer folder.
- On Gmail/Google Workspace, confirm the recovery scan uses the dedicated label and never scans Gmail All Mail, Sent, Inbox, or an existing customer label as archive input.

## 7. Address report

- Select a direct customer folder in the active mail tab.
- Run **List customer addresses**.
- Confirm only addresses at the customer's exact configured domains appear; unconfigured subdomains are excluded, and configured exact addresses appear.
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
- Delete a customer destination under the approved root, receive matching mail, and confirm the configured direct child is recreated before the message moves.
- Receive a multi-page burst larger than the preview limit and confirm automatic filing considers every message in the event instead of dropping the tail.
- Receive a matching message while another organizer operation is running; confirm the arrival list is drained and the message is rechecked before it moves.
- Temporarily disable the live new-mail listener in a development build, leave a matching message in Inbox, and confirm the startup/five-minute reconciliation moves it using the same rules.
- Repeat with a recent message already marked Read/New=false and confirm full-Inbox reconciliation still discovers it.
- With the listener enabled, receive an old-dated message and interrupt filing after its event hint is stored; confirm reconciliation still considers it. With the event deliberately omitted, confirm an old-dated scan-only discovery is reported for review and left in Inbox.
- Watch Inbox and destination unread badges during a move. Temporary flicker is acceptable; verify the actual message location rather than treating badge timing as the result.
- Add a Thunderbird filter that moves the same message after junk classification; confirm no duplicates are created. Late filters and the extension can race, so do not configure overlapping automatic rules in production.
- Force or simulate a copy event and a move with no confirmation; confirm the Inbox message is held for manual review and is not automatically attempted again.

## 9. Automatic customer contacts

- Complete **Save & set up folders**, enable automatic filing, and receive a message that automatically moves to a customer folder. Confirm customer-owned addresses from its From, To, Cc, and Bcc headers are added to that account's managed `Customer Contacts — …` book only after the move is accepted.
- Put several customer-owned addresses in one message and confirm each unique normalized address is added once with its available display name.
- Include the enabled account's own primary address and aliases/identities in the headers; confirm none of those addresses are added.
- With only `shutterfly.com` configured, include both `person@shutterfly.com` and `person@em.shutterfly.com`; confirm only the exact configured-domain address is added. Then configure the subdomain for a separate customer and confirm it is captured only for that customer's automatic move.
- Configure one exact shared-provider address, such as `customer.contact@gmail.com`, alongside an unrelated Gmail address; confirm only the configured exact address is added.
- Pre-create the same normalized email address in the managed book, then in a different Thunderbird address book. In both cases, confirm a later automatic move creates no duplicate anywhere.
- Put a customer-looking email address only in the subject or body and confirm it is never harvested as a contact, even when body matching is enabled for previews.
- Preview or Apply a reviewed move, manually move a message, and copy a message into a customer folder with another tool. Confirm none of those actions adds a contact.
- Delete the managed address book, then receive matching mail. Confirm automatic filing and contact capture pause together, the message stays in Inbox, and setup is requested. Run setup successfully, re-enable automation, and confirm later matched mail moves and captures contacts again.
- Disable automatic filing and confirm existing contacts remain. In a disposable profile, uninstall the extension and confirm its address book and contacts remain ordinary user-owned Thunderbird data.

## 10. Scale, restart, and packaging

- Set the preview limit to 25 and scan a folder with more than 25 messages; confirm the truncation banner appears.
- Scan more than one Thunderbird message-list page and confirm all pages up to the limit are processed.
- Put more than 25 protected/unmatched messages before a matching message and confirm the later actionable message is still offered.
- With the limit at 25, put the next match beyond 125 messages and confirm the preview stops at its explicit 125-message work budget instead of scanning the whole mailbox.
- Seed an Inbox with 4,000 matching messages, set the limit to 1,000, and choose **Process entire Inbox**. Confirm four reviewed Apply batches move all 4,000, followed by a fifth read-only verification batch reporting the scan complete.
- Seed more than one scan budget of protected/unmatched messages before a match. Confirm **Preview batch N+1** advances past the earlier occurrences and eventually offers the later match even though nothing in the first batch moved.
- Confirm a completed scan with sampled non-actionable rows says that all messages were examined; it must not claim that the scan safety limit stopped the query.
- Leave selected actions unapplied and choose the next batch. Confirm the warning explains they will remain in Inbox and be deferred for this run; cancel once, then explicitly accept and verify later mail is reachable.
- Restart Thunderbird during an entire-Inbox run; confirm its session progress expires and a new run safely evaluates the messages still in Inbox.
- Restart Thunderbird with a preview open; confirm it expires rather than reusing transient message IDs.
- Build the XPI and verify `manifest.json` is at the archive root.
- Load the XPI in the disposable profile and repeat the onboarding → preview → apply smoke test.
