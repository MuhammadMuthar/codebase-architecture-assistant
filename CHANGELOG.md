# Change Log

All notable changes to the "codebase-architecture-assistant" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- New command: **Codebase Assistant: Show Architecture Diagram** —
  renders the project's inter-module dependency graph as an interactive
  Mermaid `flowchart` in a webview. Edges are labelled with import
  counts; cycles are collapsed into a single annotated node; bare imports
  collapse to a single `(external)` pseudo-node. A filter input dims
  non-matching nodes for quick scanning.
- The project map now includes a real inter-module **dependency graph**
  built by parsing TS/JS imports and requires (regex-based, no new
  dependencies). The chat system prompt includes a compact summary of
  the graph, so answers can refer to actual call chains
  (e.g. "routes/orders.ts imports services/orderService.ts, which
  imports db/prisma.ts") instead of generic folder-role guesses.
- Files >200 KB are skipped from the import-graph pass (counted in
  `skippedFileCount`) with one warning per file. Hard ceiling on
  warnings per graph (20) to avoid flooding the chat.
- Known v1 limitations: TS path aliases (e.g. `@/foo` via
  `tsconfig.json` `compilerOptions.paths`) and dynamic `import('foo')`
  expressions are not resolved. Python, Go, Rust, and other non-TS/JS
  imports are silently skipped. Both are documented as future work.
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