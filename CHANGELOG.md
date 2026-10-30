# Changelog

All notable changes to NakliOS (naklios.dev). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). Releases before v3.0.0 were numbered in pull request
titles (v2.11 to v2.19, May 2026) and were not tagged.

## [3.0.0] — 2026-10-30

The first tagged release. It covers the 725 commits since v2.19 (2026-05-18).

### Added

- **Voice assistant** on LFM3-Omni-2B, running in the browser with no server. It listens hands-free or on hold-to-talk,
  speaks with the model's own voice, and loads its 2.7 GB model only after you agree to the download.
  - Tools: timers, reminders that survive a reload, calendar events (create and read), Notes lists and notes,
    memories, weather at your location, Wikipedia, a calculator, Python, page reading, music from your own files,
    battery and network status, and opening NakliOS apps.
  - Every panel action is also an `assistant.*` host command, so agents can drive it.
  - It refuses clearly what it cannot do (calls, email, smart home, directions) and asks for a missing detail.
- **Anvil**, the in-browser coding agent: skills, structured memory, hooks, supervised subagents, an event-log ledger
  that survives a reload, run review and revert, and a reason-once, run-many runner (Rote).
- **Unix shell and Forge terminal**: shared command I/O, byte pipes, sed, awk and git porcelain, with every operand
  either handled or refused.
- **Dish** (DeepSeek Harness, `dsh` v0.2.1-rc.4) and **Pi**, both hosted with NakliOS AI settings and storage.
- One skills library shared by Anvil, Dish and Pi.
- An authority layer for agents: grants, identity, history and staged changes for review.
- Vocella (Anki card reader) as a direct site and a same-origin mirror.
- Settings → App storage: move an app between a Folder and Crate, or revoke its storage.

### Changed

- LFM3 1.7B in the browser is the default AI model. Coding agents call tools on LFM3 in the browser or on OpenAI- and
  Anthropic-compatible endpoints.
- The agent tools sit in the bottom status bar instead of a floating band.
- ⌘K search and Settings stay above open windows.
- The README follows the house shape (104 lines, down from 352).

### Fixed

- Agent authority and parent-origin checks; campaign scoring.
- Anvil's model deadline pauses while a consent prompt is open.
- Anvil Python sibling imports, and a stale model after a provider change.
- Anthropic cache reads are reported in the OpenAI usage field.
- A data-loss bug in `mv`.

[3.0.0]: https://github.com/NakliTechie/nakliOS/compare/0e193dd...v3.0.0
