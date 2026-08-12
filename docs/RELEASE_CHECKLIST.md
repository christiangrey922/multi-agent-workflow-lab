# Release checklist

Use this checklist for each local release candidate. Remote publication is always a separate manual maintainer decision.

## Source and metadata

- [x] Version is synchronized at `0.1.0` where required.
- [x] Node.js and pnpm requirements are declared.
- [x] `.gitignore` excludes credentials, runtime data, logs, databases, coverage, build output, and sandbox output.
- [x] `.env.example` contains placeholders only.
- [x] README, capability matrix, changelog, release notes, security policy, contributing guide, Code of Conduct, and license are present.
- [x] Local documentation links were checked.
- [x] No live credentials were found in tracked source.

## Verification

- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm build`
- [x] `pnpm test`
- [x] `pnpm test:e2e`
- [x] `pnpm test:security`
- [x] `pnpm demo`
- [x] `pnpm mawl doctor`
- [x] README local install and demo commands were executed.

## Manual publication gates

- [ ] Add the public clone URL to contributor-facing instructions.
- [ ] Review the recommended GitHub description and topics.
- [ ] Enable private vulnerability reporting or GitHub Security Advisories.
- [ ] Create and review the `v0.1.0` tag locally.
- [ ] Review archive contents and checksums.
- [ ] Push the selected branch and tag.
- [ ] Create the GitHub release from `docs/releases/0.1.0.md`.

No remote action or package publication is performed by this checklist.
