---
title: Releases and Cloudflare Pages
group: Guides
---

# Releases and Cloudflare Pages

The documentation and React demo workspaces are private static websites. npm releases contain exactly
`@pdfextract/core`, `@pdfextract/ocr` and `@pdfextract/storage`; an explicit allowlist in
`scripts/packages.mjs` prevents either website workspace from being published.

The workflow structure follows the
[georeferencing project](https://github.com/tobilg/georeferencing/tree/main/.github/workflows):
a reusable verification workflow produces tested tarballs and a tested site artifact;
the release workflow publishes those artifacts without rebuilding them.

## npm trusted publishing

Configure each public package's npm trusted publisher with GitHub owner `tobilg`,
repository `pdfextract`, and workflow filename **`release.yml`**. No GitHub environment
name is configured by this workflow. Enable the trusted publisher's **direct `npm publish`**
permission in npm's current settings. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is used.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/) for package
registration, publisher setup and any expiry requirements.

The publishing job uses GitHub-hosted Ubuntu, `id-token: write`, Node 22.22.2 and pinned
npm 12.2.0. This publishing-tool version does not change the library runtime minimum of
22.12.0. npm exchanges GitHub's OIDC identity for short-lived publishing credentials;
provenance is automatic for eligible public repositories/packages. Repository metadata
in every package points at this GitHub repository.

Align all three public package versions before pushing `v<version>`. Stable releases
use `latest`; named prereleases use their identifier (for example `beta`); numeric
prerelease identifiers use `next`. The private documentation version is not a release target.
Use `workflow_dispatch` with its dry-run option to validate and run `npm publish --dry-run`
without publication or a Pages deployment. Real releases require a matching version tag.

The current package license is `UNLICENSED` pending the owner's decision. Real publication
is blocked until the approved license is recorded. Complete native canvas notice/provenance
review and update release documentation before the initial release. Dry-run checks remain
available. Initial npm package/scope setup is an owner operation, not performed by the workflow.

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
production branch. Manual dry runs and pull requests never deploy. The output directory
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
