import * as vscode from 'vscode';
import { ProjectMap } from './types';
import { toMermaid } from './dependencyGraph';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class DiagramViewProvider {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getProjectMap: () => ProjectMap | undefined
  ) {}

  public show(): void {
    const map = this.getProjectMap();
    if (!map) {
      vscode.window.showInformationMessage('No project map yet - open a folder first.');
      return;
    }

    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codebaseAssistant.diagram',
      'Architecture Diagram',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview, map);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private getHtml(webview: vscode.Webview, map: ProjectMap): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'mermaid.min.js')
    );
    const mermaidSource = toMermaid(map.dependencies);

    const stats = `${map.dependencies.nodes.length} nodes, ${map.dependencies.edges.length} edges` +
      (map.dependencies.externals.count > 0
        ? `, ${map.dependencies.externals.count} external imports`
        : '');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource};">
<style>
  :root {
    --accent: #E8A33D;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    margin: 0;
    padding: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
  }
  #filter {
    flex: 1;
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 5px 10px;
    font-family: inherit;
    font-size: 13px;
    max-width: 320px;
  }
  #filter:focus {
    outline: none;
    border-color: var(--accent);
  }
  #stats {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.85;
  }
  #status {
    font-size: 11px;
    color: var(--vscode-errorForeground);
    margin-left: auto;
  }
  #canvas {
    flex: 1;
    overflow: auto;
    padding: 16px;
    text-align: center;
  }
  #diagram svg {
    max-width: 100%;
    height: auto;
  }
  #raw {
    display: none;
    text-align: left;
    background: var(--vscode-textCodeBlock-background);
    padding: 12px;
    border-radius: 6px;
    overflow: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    white-space: pre;
  }
</style>
</head>
<body>
<div id="toolbar">
  <input id="filter" type="text" placeholder="Filter nodes…" />
  <span id="stats">${escapeHtml(stats)}</span>
  <span id="status"></span>
</div>
<div id="canvas">
  <div id="diagram" class="mermaid">${escapeHtml(mermaidSource)}</div>
  <pre id="raw"></pre>
</div>
<script nonce="${nonce}" src="${mermaidUri}"></script>
<script nonce="${nonce}">
  (function() {
    const statusEl = document.getElementById('status');
    const filterEl = document.getElementById('filter');
    const rawEl = document.getElementById('raw');
    const diagramEl = document.getElementById('diagram');

    if (typeof mermaid === 'undefined') {
      statusEl.textContent = 'mermaid failed to load';
      rawEl.textContent = 'mermaid.min.js did not load. Check media/ vendoring.';
      rawEl.style.display = 'block';
      diagramEl.style.display = 'none';
      return;
    }

    try {
      mermaid.initialize({
        startOnLoad: true,
        securityLevel: 'strict',
        theme: 'dark',
        flowchart: { htmlLabels: false, useMaxWidth: true }
      });
    } catch (e) {
      statusEl.textContent = 'mermaid init failed';
      rawEl.textContent = String(e && e.message || e);
      rawEl.style.display = 'block';
      diagramEl.style.display = 'none';
      return;
    }

    // Hook the global mermaid error handler so parse failures show the raw source.
    const originalError = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : null;
    if (originalError) {
      console.error = function(msg) {
        originalError(msg);
        statusEl.textContent = 'failed to render diagram';
        rawEl.style.display = 'block';
      };
    }

    filterEl.addEventListener('input', function() {
      const q = filterEl.value.trim().toLowerCase();
      document.querySelectorAll('.node').forEach(function(el) {
        const label = (el.textContent || '').toLowerCase();
        el.style.opacity = (!q || label.includes(q)) ? '1' : '0.15';
      });
    });
  })();
</script>
</body>
</html>`;
  }
}
