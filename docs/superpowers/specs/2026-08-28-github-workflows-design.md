# GitHub Actions workflows (CI + macOS releases)

Date: 2026-08-28
Status: Approved

## Problem

The repo has no CI: typecheck, tests, and the production build only run when
someone remembers to run them locally. There is also no packaging step at
all — `npm run build` emits `out/`, but nothing produces an installable dmg
or publishes downloadable releases.

## Decision

Two workflows, kept separate because they answer different questions ("is
the tree healthy?" vs "ship a build") with different triggers, runners, and
permissions. Scope chosen by the user: CI plus tag-driven, unsigned,
macOS-only releases; no repository secrets required.

### CI (`.github/workflows/ci.yml`)

- Triggers: push to `main`, every pull request.
- Runs on `ubuntu-latest` — the vitest suite is node-env and
  platform-neutral, so the cheap runner is enough.
- Steps on Node 22 (npm cache enabled): `npm ci` → `typecheck` → `test` →
  `build`.
- `permissions: contents: read`, and a per-ref `concurrency` group with
  `cancel-in-progress` so superseded pushes stop early.

### Release (`.github/workflows/release.yml`)

- Trigger: pushing a tag matching `v*`.
- Runs on `macos-latest` (arm64) so the dmg matches the target architecture
  without cross-compiling.
- Steps: fail-fast check that the tag equals `package.json`'s version →
  `npm ci` → typecheck + tests as a safety gate → `dist:mac` →
  `gh release create` attaches the dmg to a GitHub Release with generated
  notes plus a one-line Gatekeeper note.
- `permissions: contents: write` — the only workflow that writes.

### Packaging

electron-builder is added as a devDependency with a minimal
`electron-builder.yml`: app id `com.z1joey.json-reader`, dmg target, arm64
only, `identity: null` (unsigned; arm64 macOS requires at least an ad-hoc
signature, which electron-builder applies). `npm run dist:mac` runs
`electron-vite build && electron-builder --mac`.

### Practices baked in

Third-party actions pinned to full commit SHAs, minimal per-workflow
permissions, `npm ci` only, release version verified against the tag,
concurrency control, and releases published with the built-in `GITHUB_TOKEN`
— no secrets to configure.

## Files

- `.github/workflows/ci.yml`, `.github/workflows/release.yml` — the
  workflows.
- `electron-builder.yml`, `package.json` (`dist:mac` script, devDependency) —
  packaging.
- `README.md` — status badges, workflow descriptions, release instructions.
- `.gitignore` — ignore local tool dirs (`.mimosa/`, `.vscode/`, `.zcode/`).

## Out of scope

Signed/notarized builds (needs Apple Developer secrets), Windows/Linux
targets, custom app icon, auto-update (`electron-updater`), semantic-release
style release automation, and Electron binary caching in CI.
