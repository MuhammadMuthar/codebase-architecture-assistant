# Codebase Architecture Assistant

A VS Code extension that scans your open project, figures out its stack and
folder structure automatically, and lets you ask an AI chat questions about
the architecture — without having to explain the codebase yourself first.

## Features

- **Automatic project scanning** — walks your workspace on open (skipping
  `node_modules`, `.git`, build output, etc.) and builds a map of:
  - Detected languages, frameworks, and package managers (from manifest files
    like `package.json`, `requirements.txt`, or, for plain static sites with
    no build tooling, from file extensions directly)
  - Folder roles (e.g. "UI / Presentation layer", "Routing / API layer",
    "Business logic / services") based on common naming conventions
  - Monorepo support — also inspects common subfolders like `backend/`,
    `frontend/`, `api/`, etc.
- **Chat sidebar** powered by Groq, with the project map fed in as context so
  answers are specific to your actual codebase.
- **Markdown-formatted responses** — tables, headings, code blocks, and lists
  render properly instead of raw text.
- **Chat history persists** across window reloads and VS Code restarts (per
  workspace), with a "Clear chat" button when you want a fresh start.

## Getting started

You need a way to talk to Groq's API. Two options:

### Option A — Free tier (fastest way to try it out)

Just open the chat and start asking questions — no setup required. You get
**20 free questions** per install, routed through a small proxy server that
keeps the real API key private. Once you use them up, you'll see a prompt to
set your own key (see Option B).

### Option B — Bring your own Groq API key

Recommended if you plan to use this regularly, since it's not rate-limited.

1. Get a free key at [console.groq.com/keys](https://console.groq.com/keys).
2. In VS Code: `Ctrl+Shift+P` → **"Codebase Assistant: Set Groq API Key"** →
   paste your key.
3. That's it — from now on, questions go directly to Groq using your key
   instead of the shared free tier.

To switch back to the free tier later (or if you want to rotate your key),
run **"Codebase Assistant: Clear Groq API Key"** from the Command Palette.

## Commands

| Command | What it does |
|---|---|
| `Codebase Assistant: Set Groq API Key` | Save your own Groq API key (leave the prompt empty to keep whatever key is already saved) |
| `Codebase Assistant: Clear Groq API Key` | Remove your saved key and switch back to the free-tier proxy |
| `Show Project Map` | Quick popup summary of detected stack + file count |
| `Codebase Assistant: Show Architecture Diagram` | Open an interactive Mermaid diagram of the project's TS/JS import graph in a webview |

## How the free tier works (for the curious / cautious)

Your questions are **not** sent straight to Groq when using the free tier —
they go through a small proxy (see [`proxy/`](./proxy)) that:
- Holds the real Groq key server-side only; it's never shipped in this
  extension's code.
- Enforces the 20-question limit per install, tracked server-side (not just
  locally), so it can't be bypassed by reinstalling the extension.

If you want to run your own instance of this proxy (e.g. if you fork this
project), see [`proxy/README.md`](./proxy/README.md) for full deploy steps.

## Development

```bash
npm install
npm run compile      # build once
npm run watch        # rebuild on change
```

Then press `F5` in VS Code to launch an Extension Development Host with the
extension loaded.

### Testing

```bash
npm run test:unit    # fast unit tests for scanning/detection logic (no editor needed)
npm test             # full VS Code integration test (launches a real editor instance)
```

## Known limitations

- **Import-graph parser is regex-based and TS/JS-only.** It does not
  parse TypeScript path aliases (`@/foo` via `tsconfig.json` `paths`),
  dynamic `import('foo')` expressions, or imports in other languages
  (Python, Go, Rust). These are documented in `CHANGELOG.md` as future
  work.
- Files larger than 200 KB are skipped from the import-graph pass and
  counted in a `skippedFileCount` warning. Imports in those files are
  not represented.
- Stack detection covers common ecosystems (Node/npm, Python/pip, plain
  HTML/CSS/JS) but isn't exhaustive — some manifest types (Ruby, Swift,
  .NET, etc.) aren't recognized yet.
- The project map is rebuilt automatically if you switch workspace folders,
  but large structural changes made while staying in the same folder (new
  top-level directories, a newly-added package manager) aren't picked up
  until you reload the window.
- The free-tier quota is tied to VS Code's machine ID, which can reset if
  the whole VS Code installation is wiped (not just the extension).
- Very large workspaces are scanned up to an internal file cap, so the
  project map may reflect a partial (but still representative) view of the
  tree rather than every single file.

## License

MIT — see [LICENSE](./LICENSE).