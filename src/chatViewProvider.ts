import * as vscode from 'vscode';
import { ProjectMap } from './types';

const MODEL = 'openai/gpt-oss-120b';

// URL of your own proxy server that holds the real Groq key server-side
// and enforces the free-tier quota. See proxy/README.md for how to deploy one.
const PROXY_URL = 'https://codebase-assistant-proxy.muthar-dev.workers.dev/chat';
const FREE_QUESTION_LIMIT = 20;

const HISTORY_KEY = 'chatHistory';
const MAX_HISTORY_MESSAGES = 100; // keep workspaceState + payload size bounded

interface ChatHistoryEntry {
  sender: 'user' | 'assistant';
  text: string;
}

export class QuotaExceededError extends Error {
  constructor() {
    super('Free question quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebaseAssistant.chatView';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getProjectMap: () => ProjectMap | undefined,
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
    private readonly workspaceState: vscode.Memento,
    private readonly machineId: string
  ) {}

  private getHistory(): ChatHistoryEntry[] {
    return this.workspaceState.get<ChatHistoryEntry[]>(HISTORY_KEY, []);
  }

  private async appendToHistory(entry: ChatHistoryEntry): Promise<void> {
    const history = this.getHistory();
    history.push(entry);
    const trimmed = history.length > MAX_HISTORY_MESSAGES
      ? history.slice(history.length - MAX_HISTORY_MESSAGES)
      : history;
    await this.workspaceState.update(HISTORY_KEY, trimmed);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: { type: string; text: string }) => {
      if (message.type === 'ready') {
        webviewView.webview.postMessage({ type: 'restoreHistory', history: this.getHistory() });
        return;
      }

      if (message.type === 'clearHistory') {
        await this.workspaceState.update(HISTORY_KEY, []);
        return;
      }

      if (message.type === 'setKey') {
        await vscode.commands.executeCommand('codebase-architecture-assistant.setApiKey');
        return;
      }

      if (message.type !== 'ask') return;

      const map = this.getProjectMap();
      if (!map) {
        const text = "I don't have a project map yet - open a folder first.";
        webviewView.webview.postMessage({ type: 'answer', text });
        return;
      }

      await this.appendToHistory({ sender: 'user', text: message.text });

      const apiKey = await this.secrets.get('groqApiKey');

      try {
        if (apiKey) {
          const answer = await askGroq(message.text, map, apiKey);
          await this.appendToHistory({ sender: 'assistant', text: answer });
          webviewView.webview.postMessage({ type: 'answer', text: answer });
        } else {
          const { text, remaining } = await this.askViaFreeTier(message.text, map);
          await this.appendToHistory({ sender: 'assistant', text });
          webviewView.webview.postMessage({ type: 'answer', text, freeRemaining: remaining });
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          webviewView.webview.postMessage({
            type: 'quotaExceeded',
            text: 'You have used all ' + FREE_QUESTION_LIMIT + ' free questions. ' +
              'Set your own free Groq API key (console.groq.com/keys) to keep chatting.'
          });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        webviewView.webview.postMessage({ type: 'answer', text: `Error: ${msg}` });
      }
    });
  }

  /**
   * Calls our own proxy server instead of Groq directly. The proxy holds the
   * real Groq key and is the SOURCE OF TRUTH for the quota - the local
   * counter below is only used to show a friendly "x of 20 left" hint and
   * to avoid a wasted network round-trip once we already know it's spent.
   */
  private async askViaFreeTier(question: string, map: ProjectMap): Promise<{ text: string; remaining: number }> {
    const used = this.globalState.get<number>('freeQuestionsUsed', 0);
    if (used >= FREE_QUESTION_LIMIT) {
      throw new QuotaExceededError();
    }

    const systemPrompt = buildSystemPrompt(map);
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: this.machineId, systemPrompt, question })
    });

    if (response.status === 429) {
      await this.globalState.update('freeQuestionsUsed', FREE_QUESTION_LIMIT);
      throw new QuotaExceededError();
    }
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Free-tier proxy returned ${response.status}: ${errorText}`);
    }

    await this.globalState.update('freeQuestionsUsed', used + 1);
    const data: any = await response.json();
    const remaining = typeof data.remaining === 'number'
      ? data.remaining
      : Math.max(0, FREE_QUESTION_LIMIT - (used + 1));
    return { text: data.text ?? '(no text in response)', remaining };
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
  /* Markdown Tables */
  .msg table {
    border-collapse: collapse;
    width: 100%;
    margin: 8px 0;
  }
  .msg th, .msg td {
    border: 1px solid var(--vscode-panel-border);
    padding: 6px 10px;
    text-align: left;
  }
  .msg th {
    background: var(--vscode-editor-inactiveSelectionBackground);
    font-weight: 600;
  }

  /* Headings & Code */
  .msg h1, .msg h2, .msg h3, .msg h4 {
    margin: 12px 0 6px 0;
    color: var(--vscode-foreground);
  }
  .msg code {
    background: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family);
    padding: 2px 4px;
    border-radius: 3px;
  }
  .msg pre code {
    display: block;
    padding: 8px;
    overflow-x: auto;
  }
  .msg ul, .msg ol {
    margin: 6px 0;
    padding-left: 20px;
  }
  #quota-hint {
    display: none;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px 0 8px;
    text-align: right;
  }
  #quota-hint.visible {
    display: block;
  }
  #quota-hint.low {
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  }  #header-row {
    display: flex;
    justify-content: flex-end;
    padding: 6px 8px 0 8px;
  }
  #header-row button {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
    padding: 2px 8px;
    font-size: 11px;
  }
  #header-row button:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-editorWidget-background));
    color: var(--vscode-foreground);
  }
</style>
</head>
<body>
<div id="header-row">
  <button id="clear" title="Clear chat history">Clear chat</button>
</div>
<div id="messages">
  <div class="empty-state" id="empty-state">Ask a question about this project.</div>
</div>
<div id="quota-hint"></div>
<div id="input-row">
  <textarea id="question" rows="2" placeholder="Ask about this codebase..."></textarea>
  <button id="send">Send</button>
</div>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const questionEl = document.getElementById('question');
  const sendBtn = document.getElementById('send');
  const clearBtn = document.getElementById('clear');
  const emptyStateEl = document.getElementById('empty-state');
  const quotaHintEl = document.getElementById('quota-hint');
  let thinkingEl = null;

  function updateQuotaHint(remaining) {
    if (typeof remaining !== 'number') return;
    quotaHintEl.textContent = remaining === 0
      ? 'No free questions left - set your own Groq API key to continue.'
      : remaining + ' free question' + (remaining === 1 ? '' : 's') + ' remaining';
    quotaHintEl.classList.add('visible');
    quotaHintEl.classList.toggle('low', remaining <= 3);
  }

  function clearEmptyState() {
    if (emptyStateEl && emptyStateEl.parentNode) {
      emptyStateEl.parentNode.removeChild(emptyStateEl);
    }
  }

  function addMessage(text, sender, isHtml = false) {
    clearEmptyState();
    const msgDiv = document.createElement('div');
    msgDiv.className = 'msg ' + sender;

    if (isHtml) {
      msgDiv.innerHTML = text;
    } else {
      msgDiv.textContent = text;
    }

    messagesEl.appendChild(msgDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msgDiv;
  }

  function addQuotaExceededMessage(text) {
    clearEmptyState();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const p = document.createElement('div');
    p.textContent = text;
    div.appendChild(p);
    const btn = document.createElement('button');
    btn.textContent = 'Set my Groq API key';
    btn.style.marginTop = '8px';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
    div.appendChild(btn);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
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

  clearBtn.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.id = 'empty-state';
    empty.textContent = 'Ask a question about this project.';
    messagesEl.appendChild(empty);
    vscode.postMessage({ type: 'clearHistory' });
  });

  function restoreHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return;
    const empty = document.getElementById('empty-state');
    if (empty) empty.remove();
    for (const entry of history) {
      if (entry.sender === 'user') {
        addMessage(entry.text, 'user');
      } else {
        const formattedHtml = DOMPurify.sanitize(marked.parse(entry.text));
        addMessage(formattedHtml, 'assistant', true);
      }
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'answer') {
      // Parse Markdown to HTML and sanitize it
      const formattedHtml = DOMPurify.sanitize(marked.parse(message.text));

      if (thinkingEl) {
        thinkingEl.innerHTML = formattedHtml;
        thinkingEl.className = 'msg assistant';
        thinkingEl = null;
      } else {
        addMessage(formattedHtml, 'assistant', true);
      }

      updateQuotaHint(message.freeRemaining);
    } else if (message.type === 'quotaExceeded') {
      if (thinkingEl) {
        thinkingEl.remove();
        thinkingEl = null;
      }
      addQuotaExceededMessage(message.text);
      updateQuotaHint(0);
    } else if (message.type === 'restoreHistory') {
      restoreHistory(message.history);
    }
  });

  // Tell the extension host we're ready to receive persisted history.
  vscode.postMessage({ type: 'ready' });
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

function buildSystemPrompt(map: ProjectMap): string {
  return [
    'You are a codebase architecture assistant embedded in VS Code.',
    "Help the developer understand this specific project's structure and technology choices.",
    "Use the project information below. If something can't be answered from it, say so honestly rather than guessing.",
    '',
    buildContextString(map)
  ].join('\n');
}

async function askGroq(question: string, map: ProjectMap, apiKey: string): Promise<string> {
  const systemPrompt = buildSystemPrompt(map);

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