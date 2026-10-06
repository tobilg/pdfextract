# CI and release checks

All workflows use GitHub-hosted **Ubuntu only**. `verify.yml` runs on main pushes,
pull requests, manual dispatch and calls from `release.yml`. Its single `packages`
job shares a checkout, pnpm installation, library build and Playwright installation
across library, documentation and demo verification.

## Work avoided per full verification

| Work | Previous workflow | Current workflow |
| --- | --- | --- |
| Runner jobs / workspace installs | 4 (3 Linux, 1 macOS) | 1 Linux |
| Builds of the three libraries | 4 | 1 |
| Playwright installation steps | 4 | 1 |
| Core browser suite executions | 4 (workspace + packed on two OSes) | 1, packed, all 3 browsers |
| Demo browser suite | 1, all 3 browsers | 1, all 3 browsers |
| TypeDoc generation/validation | Build + repeated validation | One strict build |
| Large artifact uploads on ordinary pushes/PRs | npm + both websites | None |

These are counts from the workflow, not measured time or cost savings. There were no
GitHub Actions runs available when this change was reviewed. Fewer parallel jobs can
increase a portion of wall-clock time while reducing total runner minutes; compare
the first hosted runs before making further parallelism changes.

`actions/setup-node` caches the pnpm store by OS, architecture and lockfile; every run
still performs a frozen installation. Build outputs and `node_modules` are not cached.
The isolated packed consumer still installs from the newly generated tarballs, so a
workspace symlink or stale cached build cannot mask a missing published asset.
See [setup-node caching](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#caching-packages-data).

Browser binaries are installed once and reused by all three suites in the same job.
There is no browser cache: [Playwright advises against it](https://playwright.dev/docs/ci#caching-browsers),
particularly because Linux system dependencies still need installation. Worker counts
remain bounded for the large-image and OCR fixtures.

## Acceptance coverage retained

- All Vitest unit/integration tests run, including actual PDF decoding/OCR, image
  reference pixels, lifecycle/limits, filesystem, S3 protocol faults and local S3rver.
- PACK-01/02: all three tarballs install into an isolated consumer; Node/browser
  declarations, module isolation, native extraction and real OCR are checked.
- PACK-03 and FS-01/02: the packed consumer's Node and filesystem checks run under
  both development Node 22.22.2 and minimum Node 22.12.0. The minimum check runs no Vite.
- E2E-01, FLOW-01/02 and the browser image/OCR/limit checks run against packed assets
  under a non-root base in Chromium, Firefox and WebKit, including local S3/CORS.
- Documentation retains strict TypeDoc warnings-as-errors, example typechecking,
  link/anchor checks and Chromium navigation/search checks. The TypeDoc build performs
  the same validation as `typedoc --emit none`, so a second pass is unnecessary.
- The demo's full production-browser suite still runs in all three engines.

The duplicate workspace-development browser run remains available locally via
`pnpm test:e2e`; CI uses `pnpm test:packed-browser`. CI does not certify macOS or Windows.
External S3 service tests and hardware benchmarks remain separate opt-in checks,
unchanged by this workflow. No paths filter bypasses verification of documentation,
release scripts, dependency changes or source edits.

## Artifacts and releases

Normal pushes and PRs retain only the small documentation validation report; browser
failure traces are retained on failures. These artifacts expire after seven days.
Manual **Verify** runs can enable `upload_artifacts` to keep the three tarballs and
both built websites. **Release** always requests them. npm tarball uploads use
compression level 0 because they are already compressed;
the website artifacts keep compression enabled.

The release workflow requires verification before publishing and deploys the exact
verified websites. Artifact names, npm trusted publishing, permission scopes and
tag-only Cloudflare deployment gates are preserved. The publisher/deploy jobs use no
dependency cache. No outputs are reused from another run or a different commit.

Superseded main-branch/PR verification runs are cancelled. Tag releases and manual
runs are not cancelled by this rule, and the caller workflow name separates release
verification from ordinary verification. Event names keep manual verification separate
from automatic branch/PR runs. The required verification job is now
`packages`; if branch protection required removed matrix/site jobs, update its check
names when adopting this workflow.

**Release** only starts on pushed stable `vX.X.X` tags, for example `v0.1.0` or
`v12.34.56`. The tag filter excludes branches, `v1`, `v1.2`, and `v1.2.3-beta.1`;
`scripts/release.mjs` independently checks the format and exact package version.
There is no manual release trigger. Its dependency chain is **version → full Verify
→ npm publication → website deployments**. Failed tests prevent publication and
deployment; previous successful main-branch runs cannot substitute for the tagged
commit's verification. `RELEASE_DRY_RUN=true node scripts/release.mjs` remains a local
eligibility check, not a publishing workflow.

## Local equivalent

With Node 22.22.2 and the installed pnpm:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm assets
pnpm run pack
pnpm --filter @pdfextract/documentation build
pnpm --filter @pdfextract/documentation typecheck
pnpm --filter @pdfextract/demo build
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:packed-browser
pnpm --filter @pdfextract/documentation test
pnpm --filter @pdfextract/demo test
# After selecting Node 22.12.0, run only the built consumer:
node scripts/minimum-consumer.mjs
```

Validate workflow syntax/expressions with `actionlint`. Use `gh run list` and
`gh run view <id> --json jobs` to compare hosted step timings once runs exist; do not
infer dollar savings from local timings.
