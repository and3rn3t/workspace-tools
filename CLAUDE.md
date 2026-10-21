# GitHub Folder — Project Index

All of Matt's (and3rn3t) development projects. GitHub remotes live under `github.com/and3rn3t/`.

## Conventions

- **Web apps**: React + TypeScript + Vite, deployed to Cloudflare Workers (wrangler config in repo). Common scripts: `dev`, `build`, `lint`, `type-check`, `format`.
- **Package managers**: pnpm for `and3rn3t`, `fastlane`, `guess`, `health`; npm elsewhere.
- **Python projects**: pyproject.toml-based, several double as OpenClaw/Claude skills (have a `SKILL.md`).
- **iOS/macOS apps**: Xcode projects with `buildServer.json`; `weather-app` uses fastlane.
- **Game dev**: `catastrophe` is an Unreal Engine 5 project — `tools/*.mjs` classify it as `other` (no package.json/pyproject.toml) and it has no CI template; it still receives the universal baseline files (`.editorconfig`, `SECURITY.md`, consistency guard). `hack` is Rust (Cargo.toml) — also classified as `other` by the tooling (no Rust-specific type yet), same baseline-only treatment.
- Per-repo detail lives in each repo's own `CLAUDE.md` where present (marked ✓ below).

## Web / Cloudflare Workers (React + TS)

| Repo | What it is |
|---|---|
| `and3rn3t` ✓ | Personal portfolio site (worker: `and3rn3t-portfolio`) — pnpm |
| `cats` | "Cat Collector" — educational cat-breed collection game for kids — npm |
| `family` | Family Organizer — chore/schedule kiosk app for Raspberry Pi 4B — npm |
| `fastlane` ✓ | Fast Lane — single-player life-sim board game (React + TS + Vite) — pnpm |
| `flipper` ✓ | Flipper Zero Lab — interactive experimentation dashboard, no hardware required |
| `guess` ✓ | "Andernator" guessing game — pnpm monorepo (`apps/`) |
| `health` ✓ | VitalSense — Apple Health insights, fall risk detection, caregiver dashboards; multiple workers incl. websocket — pnpm |
| `homehub` ✓ | Smart home dashboard, React 19, live camera streaming |
| `huggingface` ✓ | HuggingFace Playground — browse datasets/models, experiment with AI APIs |
| `jonah` ✓ | Personal portfolio for Jonah (GitHub Spark template) |
| `net-traffic` ✓ | NetInsight — network traffic analysis dashboard — npm |
| `posture` | Spark template starter (early stage) _(archived)_ |
| `silas` | Personal website for Silas Anderson, with an embedded RPG game — npm |
| `sky` ✓ | Celestial-event discovery platform — location-aware night-sky alerts (GitHub Spark template, early stage) — npm |
| `telescope` | JWST Deep Sky Explorer — 3D telescope visualization using NASA APIs (GitHub Spark template) — npm |

## Python (CLI tools & skills)

| Repo | What it is |
|---|---|
| `amiibo` ✓ | amiibo-flipper — fetch amiibo metadata, export Flipper-friendly files |
| `apple-music-dj` ✓ | Apple Music curation engine — packaged as a skill (`SKILL.md`) |
| `apple-photos-cleaner` ✓ | Photos library audit/cleanup via its SQLite DB — packaged as a skill (`SKILL.md`) |
| `birds` ✓ | fugleramme — e-ink bird frame for Raspberry Pi, real-time bird detection by audio (pyproject.toml) |
| `dbt` | Data science/analytics workspace — Python analysis + dbt transforms + notebooks |
| `minecraft` ✓ | Minecraft server setup/control for Raspberry Pi 5, Docker-based |
| `network` ✓ | NetworkMonitor — UniFi API integration for network monitoring; Python backend + `workers/` (Cloudflare Workers) |
| `vac` | Connecting to a robotic vacuum without cloud services — mixed Python backend + npm mobile-app |

## iOS / macOS (Xcode)

| Repo | What it is |
|---|---|
| `homekit-automator` | HomeKit automation tool; nested Xcode project, Homebrew Formula |
| `Printer` ✓ | iOS app for Anycubic 3D printers (Printer.xcodeproj) |
| `remote` ✓ | Denon AVR remote control app, iOS 26 Liquid Glass design |
| `weather-app` | Weather app for iOS & Android, fastlane for release |

## Game dev

| Repo | What it is |
|---|---|
| `catastrophe` | "CATastrophe: A Mischief Simulator" — 3D open-world cat game, Unreal Engine 5 |
| `hack` | "The Hack: Ghost Protocol" — horror-themed terminal hacking sim / CTF, Rust, deploys as a Cloudflare Worker |

## Templates, experiments & misc

| Repo | What it is |
|---|---|
| `.github` | Shared reusable workflows, workflow templates, default SECURITY.md for all and3rn3t repos (must be public on GitHub) |
| `ai-template-repo` ✓ | Canonical AI-assisted dev template (CLAUDE.md, AGENTS.md, Copilot/Cursor configs) — baseline for new repos |
| `apple-shortcuts-doctor` ✓ | Shortcuts Doctor — static inspection of Apple Shortcuts exports (what it does, data exposure, breakage) without running it — TS CLI, npm |
| `docker-playground` | docker-playground experiments |
| `eslint-config` | Shared ESLint 9 flat config package for and3rn3t React + TypeScript repos — private, npm |
| `r-data` ✓ | R data-analysis workspace with example scripts |
| `reddit` | daily-briefing experiment (Reddit + news digest skill) _(archived)_ |
| `test-project` ✓ | Template test bed (mirrors ai-template-repo structure) |
| `tools` | Meta-workspace tooling (tracked in this root repo, `workspace-tools`): `make doctor/status/sync/drift/dashboard` — consistency + orchestration across all repos; see `tools/README.md` |

## Notes for Claude

- Prefer each repo's own CLAUDE.md when working inside it; this file is only the map.
- Cloudflare deploys go through wrangler; a Cloudflare MCP connector is available in Cowork sessions.
- Don't commit or deploy without being asked.
