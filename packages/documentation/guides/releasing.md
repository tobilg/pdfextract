---
title: Releases and Cloudflare Pages
group: Guides
---

# Releases and Cloudflare Pages

The documentation and React demo workspaces are private static websites. npm releases contain exactly
`@pdfextract/core`, `@pdfextract/ocr` and `@pdfextract/storage`; an explicit allowlist in
`scripts/packages.mjs` prevents either website workspace from being published.

A reusable verification workflow produces tested tarballs and a tested site artifact;
the release workflow publishes those artifacts without rebuilding them.

Verification uses one Linux job for libraries and both websites, sharing one dependency
installation, library build and browser installation. Chromium, Firefox and WebKit test
the packed consumer and production demo; Node 22.22.2 and 22.12.0 test the built packages.
Ordinary pushes/PRs retain a small validation report and failure traces. Release runs
request all release artifacts; manual Verify runs can opt in with `upload_artifacts`.
See the [CI coverage and optimization notes](https://github.com/tobilg/pdfextract/blob/main/.github/CI.md).

## npm trusted publishing

Configure each public package's npm trusted publisher with GitHub owner `tobilg`,
repository `pdfextract`, and workflow filename **`release.yml`**. No GitHub environment
name is configured by this workflow. Enable the trusted publisher's **direct `npm publish`**
permission in npm's current settings. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is used.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/) for package
registration, publisher setup and any expiry requirements.

The publishing job uses GitHub-hosted Ubuntu, `id-token: write` and the latest Node 24
with its bundled npm (trusted publishing needs npm 11.5.1 or newer; the job checks this).
It only uploads the already verified tarballs, so this does not change the library runtime
minimum of 22.12.0, which verification tests. npm exchanges GitHub's OIDC identity for short-lived publishing credentials;
provenance is automatic for eligible public repositories/packages. Repository metadata
in every package points at this GitHub repository.

Align package versions before pushing a stable tag such as `v1.2.3`:

```sh
pnpm version:sync 1.2.3 --dry-run # Preview without writing
pnpm version:sync 1.2.3           # Set all five packages and internal peer ranges
pnpm version:check               # Read-only alignment check, also run by CI
```

Omit the version argument to synchronize to `@pdfextract/core`'s current version.
Only stable `X.Y.Z` versions are accepted, without a `v` prefix or prerelease suffix.
The script preserves `workspace:*` dependencies and external dependency versions;
internal peer ranges become `^X.Y.Z`. With the current workspace links, these metadata
changes require no lockfile rewrite. No commit, tag or publication is created. Commit
the manifest changes before creating the matching release tag.

The release workflow runs **only** on pushed `vX.X.X` tags. Branch pushes, prerelease
suffixes and manual dispatch do not start a release. Each release runs the complete
reusable verification workflow for its own tagged commit; npm publication depends on
all builds, tests and packed-consumer checks succeeding. Stable releases use `latest`.
The private website versions are synchronized metadata, not npm release targets.

All packages are MIT-licensed; `scripts/release.mjs` refuses to publish a package whose
license is missing or `UNLICENSED`. Local eligibility checks remain available with
`RELEASE_DRY_RUN=true node scripts/release.mjs`; this command does not publish.

The **first** version of each package is published manually by the owner, because npm
only allows configuring a trusted publisher for a package that already exists. Create
the `pdfextract` npm organization, then publish the verified tarballs from
`pnpm run pack` (`artifacts/pdfextract-{core,ocr,storage}-X.Y.Z.tgz`), core first, with
`npm publish ./artifacts/pdfextract-core-X.Y.Z.tgz --access public`. Keep the leading `./`:
without it, npm reads `artifacts/…` as a GitHub repository and fails. Afterwards configure the trusted publisher for
each package as described above; later releases use the tag workflow only.

Publication is sequential, core first. Already-published exact versions are skipped after
a successful registry lookup; only a 404 means absent. Permission/network/server errors
stop the job. Publishing multiple packages is not atomic; a failed run can be retried.

## Cloudflare Pages

Create a Direct Upload Pages project (default name **`pdfextract-api-docs`**) in your
Cloudflare account with production branch `main`. This repository does not provision
the project or configure a domain. A custom domain can be attached in the Pages dashboard.

Configure repository secrets `CLOUDFLARE_API_TOKEN` (scoped to Pages edit for the chosen
account) and `CLOUDFLARE_ACCOUNT_ID`. Set repository variable `CLOUDFLARE_PAGES_PROJECT`
to override the default project name. These are Cloudflare deployment credentials,
separate from npm's tokenless trusted publishing.

After a pushed release tag passes CI and npm publication, `release.yml` downloads the
verified `documentation` artifact and deploys it with pinned Wrangler to the Pages
production branch. Manual verification runs and pull requests never deploy. The output directory
is `packages/documentation/dist`; it contains HTML, relative assets and search data,
with no runtime server or Pages Functions. Keep directory-index resolution enabled.

The checked-in `wrangler.jsonc` describes the default local Pages configuration. The
workflow's project-name override selects the actual host-owned project. For local
preview, run `pnpm docs:preview`; no Cloudflare credentials are required.

The React demo has a separate Direct Upload project, **`pdfextract-demo`**, also using
production branch `main`. Set `CLOUDFLARE_DEMO_PAGES_PROJECT` to override its name. It uses
the same account/token secrets. The verification workflow runs real PDF/OCR browser
tests in Chromium, Firefox and WebKit, then uploads `packages/demo/dist` as the `demo`
artifact. Tagged releases deploy that artifact after npm publication; the demo is never
published to npm. Its self-hosted worker/WASM/model files require no runtime backend.
Run `pnpm demo:dev` or `pnpm demo:preview` locally on port 4176. See the
[demo README](https://github.com/tobilg/pdfextract/blob/main/packages/demo/README.md).

See [Cloudflare's direct-upload CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
Local build/test commands never publish npm packages or deploy the website.
