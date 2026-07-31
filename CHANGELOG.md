# Change Log

All notable changes to the "codebase-architecture-assistant" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- The system prompt now explicitly restricts the assistant to programming
  and codebase topics, with a fixed decline message for out-of-scope
  questions (e.g. medical, financial, or general life advice). Applies to
  both the free-tier proxy path and BYO API key path, and to the
  "Explain File"/"Explain Selection" commands, since they all share the
  same prompt builder.

## [0.0.2]

- Removed stray compiled `.js`/`.js.map` files and leftover `.patch` files
  that had been accidentally committed to the repo root.
- `.gitignore` now excludes root-level `.js`/`.js.map` output and `.patch`
  files so this doesn't happen again.
- Fixed the README's License section (it said "Not yet specified" even
  though the project is MIT-licensed) and removed a stale "known
  limitation" that no longer applied (multi-turn chat context).
- Added `keywords` to `package.json` for Marketplace search.
- Project scan now guards against symlink loops and caps the number of
  files walked, so it can't hang or blow up memory on unusual or very
  large workspaces.
- The initial workspace scan runs with a visible progress notification
  instead of silently blocking, and the project map is now rebuilt
  automatically if the user switches workspace folders.