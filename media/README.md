# media/

## mermaid.min.js

Vendored copy of the Mermaid rendering library, used by the **"Codebase
Assistant: Show Architecture Diagram"** command. Bundled locally so the
webview never has to reach out to a CDN.

### Refreshing this file

Mermaid is not added to `package.json` `dependencies` — it's vendored as a
static asset so the extension's runtime footprint is unchanged for users who
don't open the diagram view.

To upgrade:

```bash
# 1. Download the latest tarball
curl -sL https://registry.npmjs.org/mermaid/-/mermaid-$(npm view mermaid version).tgz -o /tmp/mermaid.tgz

# 2. Extract and copy the UMD bundle
mkdir -p /tmp/mermaid-extract
tar -xzf /tmp/mermaid.tgz -C /tmp/mermaid-extract
cp /tmp/mermaid-extract/package/dist/mermaid.min.js media/mermaid.min.js

# 3. Update the version comment below
```

This file is referenced by `src/diagramViewProvider.ts` via
`webview.asWebviewUri(media/mermaid.min.js)`. Make sure `.vscodeignore`
does not exclude it.

### Current version

mermaid 11.16.0 (UMD bundle, ~3.5 MB minified).