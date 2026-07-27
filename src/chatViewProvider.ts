import * as vscode from 'vscode';
import { ProjectMap } from './types';

const MODEL = 'openai/gpt-oss-120b';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebaseAssistant.chatView';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getProjectMap: () => ProjectMap | undefined,
    private readonly secrets: vscode.SecretStorage
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: { type: string; text: string }) => {
      if (message.type !== 'ask') return;

      const map = this.getProjectMap();
      if (!map) {
        webviewView.webview.postMessage({
          type: 'answer',
          text: "I don't have a project map yet - open a folder first."
        });
        return;
      }

      const apiKey = await this.secrets.get('groqApiKey');
      if (!apiKey) {
        webviewView.webview.postMessage({
          type: 'answer',
          text: 'No Groq API key set yet. Run "Codebase Assistant: Set Groq API Key" from the Command Palette first.'
        });
        return;
      }

      try {
        const answer = await askGroq(message.text, map, apiKey);
        webviewView.webview.postMessage({ type: 'answer', text: answer });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        webviewView.webview.postMessage({ type: 'answer', text: `Error calling Groq API: ${msg}` });
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background-color: var(--vscode-sideBar-background);
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    box-sizing: border-box;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .msg {
    margin-bottom: 12px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.4;
    white-space: pre-wrap;
  }
  .msg.user {
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .msg.assistant {
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, transparent);
  }
  .msg.thinking {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .empty-state {
    color: var(--vscode-descriptionForeground);
    padding: 16px 12px;
    font-size: 13px;
  }
  #input-row {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  #question {
    flex: 1;
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 13px;
    resize: none;
  }
  button {
    background-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover {
    background-color: var(--vscode-button-hoverBackground);
  }
</style>
</head>
<body>
<div id="messages">
  <div class="empty-state">Ask a question about this project.</div>
</div>
<div id="input-row">
  <textarea id="question" rows="2" placeholder="Ask about this codebase..."></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const questionEl = document.getElementById('question');
  const sendBtn = document.getElementById('send');
  let thinkingEl = null;

  function addMessage(text, role) {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function send() {
    const text = questionEl.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    thinkingEl = addMessage('Thinking...', 'assistant thinking');
    vscode.postMessage({ type: 'ask', text });
    questionEl.value = '';
  }

  sendBtn.addEventListener('click', send);
  questionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'answer') {
      if (thinkingEl) {
        thinkingEl.textContent = message.text;
        thinkingEl.className = 'msg assistant';
        thinkingEl = null;
      } else {
        addMessage(message.text, 'assistant');
      }
    }
  });
</script>
</body>
</html>`;
  }
}

function buildContextString(map: ProjectMap): string {
  const { languages, frameworks, packageManagers } = map.stack;
  const structureLines = map.structure
    .map(s => `- ${s.path}: ${s.role} (${s.fileCount} files, e.g. ${s.sampleFiles.join(', ') || 'n/a'})`)
    .join('\n');

  return [
    `Project root: ${map.root}`,
    `Languages: ${languages.join(', ') || 'unknown'}`,
    `Frameworks: ${frameworks.join(', ') || 'none detected'}`,
    `Package managers: ${packageManagers.join(', ') || 'unknown'}`,
    `Total files: ${map.totalFiles}`,
    'Folder structure:',
    structureLines || '(no recognized folders mapped)'
  ].join('\n');
}

async function askGroq(question: string, map: ProjectMap, apiKey: string): Promise<string> {
  const systemPrompt = [
    'You are a codebase architecture assistant embedded in VS Code.',
    "Help the developer understand this specific project's structure and technology choices.",
    "Use the project information below. If something can't be answered from it, say so honestly rather than guessing.",
    '',
    buildContextString(map)
  ].join('\n');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API returned ${response.status}: ${errorText}`);
  }

  const data: any = await response.json();
  const text = data.choices?.[0]?.message?.content;
  return text ?? '(no text in response)';
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
