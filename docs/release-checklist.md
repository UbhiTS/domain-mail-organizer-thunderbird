# Release and rollback checklist

Use this checklist for every public Thunderbird Add-ons or GitHub release.
Never reuse, move, or overwrite a published version tag.

## Release gates

Status for the current `0.1.12` working tree: automated checks are complete,
but the disposable Thunderbird 140+/real-provider acceptance run below has not
yet been executed. Do not tag or submit this version until that evidence is
recorded.

- [ ] Start from a clean checkout of the intended `main` commit.
- [ ] Confirm GitHub's required `Build` check passed on that exact commit.
- [ ] Run `npm ci --ignore-scripts` with the supported Node/npm versions.
- [ ] Run `npm audit --omit=dev --audit-level=high`; runtime findings must be zero.
- [ ] Run `npm run check`; all tests, syntax/version checks, and the strict lint
      warning allowlist must pass.
- [ ] Run `npm run build`; verify the XPI and ZIP have the same SHA-256 digest.
- [ ] Inspect the XPI: `manifest.json`, `LICENSE`, and `NOTICE` must be at its
      root; no `node_modules`, credentials, mailbox exports, or source maps may
      be present.
- [ ] Execute `docs/manual-test-plan.md` in a disposable Thunderbird 140+
      profile. Record the Thunderbird version, OS, provider/account type,
      extension commit/version, date, tester, and any deviations.
- [ ] At minimum, test a real Gmail/Google Workspace or IMAP account plus:
      setup with ordinary and special-use Archive-name collisions; exact-domain
      routing; automatic move confirmation timing; restart/offline recovery;
      folder rename/delete; address-book outage; 4,000-message Inbox processing;
      and repeat-safe existing-mail contact backfill.
- [ ] Resolve every blocker/high finding. Document any accepted lower-severity
      limitation in README, PRIVACY, and version notes.

## Publish

- [ ] Verify `package.json`, `package-lock.json`, and `extension/manifest.json`
      have the same unused version.
- [ ] Create an annotated (preferably signed) `v<version>` tag on the exact
      audited commit and push it without force.
- [ ] Download the CI artifact for that commit and verify `SHA256SUMS.txt`.
- [ ] Create the GitHub Release manually. Attach the CI-built XPI, ZIP, and
      checksums; never rebuild from a different commit for the same version.
- [ ] Submit that XPI to addons.thunderbird.net using
      `docs/atn-submission.md`, then smoke-test the signed ATN build.
- [ ] Record the final tag, commit, artifact hashes, ATN version/status, test
      evidence, and release date in the release notes or issue tracker.

## Rollback / emergency response

1. Disable the affected ATN version or distribution listing when user data or
   mail safety is at risk.
2. Preserve evidence and privately triage security reports through the process
   in `SECURITY.md`; do not ask reporters for real mailbox data.
3. Revert or fix on a new commit, assign a strictly higher patch version, and
   rerun every release gate above. Never retarget the old tag or publish a
   lower version as the fix.
4. Publish a concise impact statement, affected versions, workaround, and
   upgrade instructions. Keep folders, contacts, and safety-journal behavior in
   mind when describing recovery.
