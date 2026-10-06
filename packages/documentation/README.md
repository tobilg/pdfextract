---
title: Documentation workspace
group: Guides
---

# @pdfextract/documentation

Private TypeDoc website for the three public pdfextract packages. This workspace is
**not published to npm**. Its static `dist/` directory is deployed to Cloudflare Pages
by `.github/workflows/release.yml` after successful verification and npm publication.

The structure follows the georeferencing documentation workspace: strict source comments,
handwritten guides, typechecked embedded examples, HTML link/anchor checks, and a real
browser navigation/search check. TypeDoc 0.28.20 supports the workspace's TypeScript 6.0.3.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test:docs
pnpm docs:preview
```

Open **http://127.0.0.1:4174/**. For source/guide watch mode, run `pnpm docs:dev`.
`pnpm docs:build` builds library declarations and emits the website. `pnpm docs:check`
validates all public API documentation and typechecks guide examples (build first on a
fresh checkout). The site checker uses Playwright Chromium; install it with
`pnpm exec playwright install chromium` when absent.

Edit public API comments in `packages/{core,ocr,storage}/src`, package usage in each
package's `README.md`, website content in `landing.md` and `guides/`, and included code
in `examples/`. The local `scripts/package-readmes.mjs` TypeDoc plugin places each public
package's README above its API listing on the package entry page, without a separate
README subpage. It omits the duplicate top-level heading and maps Markdown README links
to the package page. The same source files remain readable on npm and in the repository.
`landing.md` is the main website README and quick start. Strict validation fails on
undocumented public symbols or invalid links. Source comments also ship in library `.d.ts`
files for editor help. The root `docs/` directory remains ignored local material and is
not an input to this site's generation or CI.

`typedoc.json` includes the core/OCR/storage root APIs and both storage adapter subpaths.
Its explicit `projectDocuments` list orders the guides from onboarding through OCR,
storage and fidelity to documentation maintenance and releases. Add new guides at the
appropriate point in that list; TypeDoc preserves document order by default.
The built-in static theme provides search and light/dark presentation. Generated files
are ignored; the source configuration, comments, guides and examples are versioned.

See [release setup](guides/releasing.md) for npm OIDC configuration, Cloudflare secrets
and the host-owned Pages project. Local commands do not deploy. The owner package license
remains unresolved; this private package uses UNLICENSED consistently with the workspace.
