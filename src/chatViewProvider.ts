import * as vscode from 'vscode';
import { ProjectMap } from './types';

const MODEL = 'openai/gpt-oss-120b';

// URL of your own proxy server that holds the real Groq key server-side
// and enforces the free-tier quota. See proxy/README.md for how to deploy one.
const PROXY_URL = 'https://codebase-assistant-proxy.muthar-dev.workers.dev/';
const FREE_QUESTION_LIMIT = 20;
const FREE_WINDOW_SECONDS = 60 * 60 * 24; // 24 hours, mirrors proxy/worker.js

const HISTORY_KEY = 'chatHistory';
const MAX_HISTORY_MESSAGES = 100; // keep workspaceState + payload size bounded

// Bounds on how much PRIOR conversation gets fed back into the model as
// context (separate from MAX_HISTORY_MESSAGES above, which only bounds what's
// persisted for display). Kept deliberately smaller than the display history
// so a long session doesn't balloon token cost/latency on every question.
const MAX_CONTEXT_TURNS = 12;          // most recent prior user+assistant messages to include
const MAX_CONTEXT_ENTRY_CHARS = 1500;  // per-message cap when replayed as context
const MAX_CONTEXT_TOTAL_CHARS = 8000;  // combined cap across all prior context messages

interface ChatHistoryEntry {
  sender: 'user' | 'assistant';
  text: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class QuotaExceededError extends Error {
  constructor(public readonly resetInSeconds?: number) {
    super('Free question quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebaseAssistant.chatView';

  private view?: vscode.WebviewView;
  private webviewReady = false;
  private pendingExternalAsk?: { displayText: string; prompt: string };

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
        this.webviewReady = true;
        webviewView.webview.postMessage({ type: 'restoreHistory', history: this.getHistory() });
        if (this.pendingExternalAsk) {
          const pending = this.pendingExternalAsk;
          this.pendingExternalAsk = undefined;
          await this.runExternalAsk(webviewView.webview, pending.displayText, pending.prompt);
        }
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
      await this.processAndRespond(webviewView.webview, map, message.text);
    });
  }

  /**
   * Entry point for commands outside the chat input box (e.g. "Ask about this
   * file" from the Explorer, "Explain selection" from the editor). Brings the
   * chat view into focus, shows the question in the chat like a normal typed
   * one, and runs it through the exact same Groq/proxy/history pipeline.
   */
  public async askExternally(displayText: string, prompt: string): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);

    if (!this.view) {
      vscode.window.showWarningMessage('Could not open the Codebase Assistant chat view.');
      return;
    }

    if (!this.webviewReady) {
      // The webview page hasn't finished loading/registering its message
      // listener yet - queue this and the 'ready' handshake above will run it.
      this.pendingExternalAsk = { displayText, prompt };
      return;
    }

    await this.runExternalAsk(this.view.webview, displayText, prompt);
  }

  private async runExternalAsk(webview: vscode.Webview, displayText: string, prompt: string): Promise<void> {
    const map = this.getProjectMap();
    if (!map) {
      webview.postMessage({
        type: 'answer',
        text: "I don't have a project map yet - open a folder first."
      });
      return;
    }

    webview.postMessage({ type: 'userMessage', text: displayText });
    await this.appendToHistory({ sender: 'user', text: displayText });
    await this.processAndRespond(webview, map, prompt);
  }

  private async processAndRespond(webview: vscode.Webview, map: ProjectMap, promptForModel: string): Promise<void> {
    const apiKey = await this.secrets.get('groqApiKey');

    // getHistory() already includes the current question as its last entry
    // (appendToHistory ran before processAndRespond was called), so prior
    // context is everything before that. We replay those prior turns as-is,
    // then use promptForModel — not the possibly-different displayText that
    // was stored for the current turn — as the final user message, so
    // enriched prompts (e.g. "Explain selection" with the code attached)
    // still reach the model in full on the turn they're asked, while only
    // their short display label is replayed as context in later turns.
    const priorHistory = this.getHistory().slice(0, -1);
    const conversationMessages = buildConversationMessages(priorHistory, promptForModel);

    try {
      if (apiKey) {
        const answer = await askGroq(conversationMessages, map, apiKey);
        await this.appendToHistory({ sender: 'assistant', text: answer });
        webview.postMessage({ type: 'answer', text: answer });
      } else {
        const { text, remaining } = await this.askViaFreeTier(conversationMessages, map);
        await this.appendToHistory({ sender: 'assistant', text });
        webview.postMessage({ type: 'answer', text, freeRemaining: remaining });
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const hoursLeft = typeof err.resetInSeconds === 'number'
          ? Math.max(1, Math.ceil(err.resetInSeconds / 3600))
          : undefined;
        const resetMsg = hoursLeft
          ? `They'll reset in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}, `
          : 'They reset every 24 hours, ';
        webview.postMessage({
          type: 'quotaExceeded',
          text: 'You have used all ' + FREE_QUESTION_LIMIT + ' free questions for this 24h window. ' +
            resetMsg + 'or set your own free Groq API key (console.groq.com/keys) to keep chatting now.'
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: 'answer', text: `Error: ${msg}` });
    }
  }

  /**
   * Calls our own proxy server instead of Groq directly. The proxy holds the
   * real Groq key and is the SOURCE OF TRUTH for the quota - the local
   * counter below is only used to show a friendly "x of 20 left" hint and
   * to avoid a wasted network round-trip once we already know it's spent.
   */
  private async askViaFreeTier(messages: ConversationMessage[], map: ProjectMap): Promise<{ text: string; remaining: number }> {
    const now = Math.floor(Date.now() / 1000);
    let used = this.globalState.get<number>('freeQuestionsUsed', 0);
    let windowStart = this.globalState.get<number>('freeTierWindowStart', now);

    if (now - windowStart >= FREE_WINDOW_SECONDS) {
      // A full 24h window has passed since the first question in the
      // previous window: start a fresh one, locally, before even asking
      // the proxy (the proxy will independently agree, since it uses the
      // same fixed-window logic keyed by machineId).
      used = 0;
      windowStart = now;
      await this.globalState.update('freeQuestionsUsed', 0);
      await this.globalState.update('freeTierWindowStart', windowStart);
    }

    if (used >= FREE_QUESTION_LIMIT) {
      throw new QuotaExceededError(FREE_WINDOW_SECONDS - (now - windowStart));
    }

    const systemPrompt = buildSystemPrompt(map);
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: this.machineId, systemPrompt, messages })
    });

    if (response.status === 429) {
      // Server-side is the source of truth; sync our local state to it.
      let resetInSeconds: number | undefined;
      try {
        const errData: any = await response.json();
        resetInSeconds = typeof errData.resetInSeconds === 'number' ? errData.resetInSeconds : undefined;
      } catch {
        // ignore parse errors, fall back to local estimate below
      }
      await this.globalState.update('freeQuestionsUsed', FREE_QUESTION_LIMIT);
      if (typeof resetInSeconds === 'number') {
        await this.globalState.update('freeTierWindowStart', now - (FREE_WINDOW_SECONDS - resetInSeconds));
      }
      throw new QuotaExceededError(resetInSeconds ?? FREE_WINDOW_SECONDS - (now - windowStart));
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
  :root {
    --accent: #E8A33D;
  }
  * {
    box-sizing: border-box;
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background-color: var(--vscode-sideBar-background);
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-size: 13px;
  }
  #app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  #brand {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  #brand-mark {
    width: 15px;
    height: 15px;
    color: var(--accent);
    flex-shrink: 0;
  }
  #brand-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    opacity: 0.82;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    border-radius: 5px;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px 12px;
  }
  .msg {
    margin-bottom: 16px;
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
    max-width: 94%;
  }
  .msg.user {
    margin-left: auto;
    background-color: var(--vscode-list-inactiveSelectionBackground, var(--vscode-editorWidget-background));
    color: var(--vscode-foreground);
    padding: 7px 11px;
    border-radius: 10px 10px 2px 10px;
  }
  .msg.assistant {
    border-left: 2px solid var(--accent);
    padding: 1px 0 1px 12px;
  }
  .msg.thinking {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    border-left-color: var(--vscode-panel-border);
  }
  .quota-card {
    background: var(--vscode-editorWidget-background);
    border-radius: 0 8px 8px 0;
    padding: 10px 12px;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 10px;
    color: var(--vscode-descriptionForeground);
    padding: 44px 24px;
  }
  #empty-mark {
    width: 30px;
    height: 30px;
    color: var(--accent);
    opacity: 0.9;
  }
  #input-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  #question {
    flex: 1;
    background-color: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 7px 10px;
    font-family: inherit;
    font-size: 13px;
    resize: none;
    min-height: 32px;
    max-height: 120px;
    overflow-y: auto;
    transition: border-color 0.12s ease;
  }
  #question:focus {
    outline: none;
    border-color: var(--accent);
  }
  #send {
    width: 32px;
    height: 32px;
    background: var(--accent);
    color: #1B1E24;
    border-radius: 8px;
  }
  #send:hover {
    background: #F0AE52;
    color: #1B1E24;
  }
  #send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn-accent {
    background: var(--accent);
    color: #1B1E24;
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    margin-top: 8px;
  }
  .btn-accent:hover {
    background: #F0AE52;
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
    text-align: right;
    padding: 0 10px;
  }
  #quota-hint.visible {
    display: block;
  }
  #quota-hint .pill {
    display: inline-block;
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, rgba(127,127,127,0.15));
    padding: 2px 9px;
    border-radius: 9px;
    margin-bottom: 6px;
  }
  #quota-hint.low .pill {
    color: var(--accent);
  }
</style>
</head>
<body>
<header id="app-header">
  <div id="brand">
    <svg id="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M21 7V4.5A1.5 1.5 0 0 0 19.5 3H17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 17v2.5A1.5 1.5 0 0 0 4.5 21H7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12 9.8L8.4 14.6M12 9.8l3.6 4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="12" cy="8.4" r="1.7" fill="currentColor"/>
      <circle cx="8" cy="15.8" r="1.7" fill="currentColor"/>
      <circle cx="16" cy="15.8" r="1.7" fill="currentColor"/>
    </svg>
    <span id="brand-label">Codebase Assistant</span>
  </div>
  <button id="clear" class="icon-btn" title="Clear chat" aria-label="Clear chat">
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v1.7M4.6 4.5l.6 8.8c.03.5.45.9.95.9h3.7c.5 0 .92-.4.95-.9l.6-8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
</header>
<div id="messages">
  <div class="empty-state" id="empty-state">
    <svg id="empty-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M21 7V4.5A1.5 1.5 0 0 0 19.5 3H17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 17v2.5A1.5 1.5 0 0 0 4.5 21H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12 9.8L8.4 14.6M12 9.8l3.6 4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <circle cx="12" cy="8.4" r="1.6" fill="currentColor"/>
      <circle cx="8" cy="15.8" r="1.6" fill="currentColor"/>
      <circle cx="16" cy="15.8" r="1.6" fill="currentColor"/>
    </svg>
    <p style="margin: 0;">Ask a question about this project's structure, stack, or code.</p>
  </div>
</div>
<div id="quota-hint"></div>
<div id="input-row">
  <textarea id="question" rows="1" placeholder="Ask about this codebase…"></textarea>
  <button id="send" class="icon-btn" title="Send" aria-label="Send message">
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 8L13.5 2.2a.5.5 0 0 1 .7.6L11 13.5a.5.5 0 0 1-.94.05L7 8l-4.7-.3a.4.4 0 0 1-.3-.7z" fill="currentColor"/>
    </svg>
  </button>
</div>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const EMPTY_STATE_HTML = messagesEl.innerHTML;
  const questionEl = document.getElementById('question');
  const sendBtn = document.getElementById('send');
  const clearBtn = document.getElementById('clear');
  const quotaHintEl = document.getElementById('quota-hint');
  let thinkingEl = null;

  function updateQuotaHint(remaining) {
    if (typeof remaining !== 'number') return;
    const text = remaining === 0
      ? 'No free questions left — set your own Groq API key to continue'
      : remaining + ' free question' + (remaining === 1 ? '' : 's') + ' remaining';
    quotaHintEl.innerHTML = '<span class="pill">' + text + '</span>';
    quotaHintEl.classList.add('visible');
    quotaHintEl.classList.toggle('low', remaining <= 3);
  }

  function clearEmptyState() {
    // Looked up fresh each time (rather than cached once) since "Clear chat"
    // re-creates a brand new empty-state element with the same id.
    const el = document.getElementById('empty-state');
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
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
    div.className = 'msg assistant quota-card';
    const p = document.createElement('div');
    p.textContent = text;
    div.appendChild(p);
    const btn = document.createElement('button');
    btn.className = 'btn-accent';
    btn.textContent = 'Set my Groq API key';
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
    autoGrow();
  }

  function autoGrow() {
    questionEl.style.height = 'auto';
    questionEl.style.height = Math.min(questionEl.scrollHeight, 120) + 'px';
  }
  questionEl.addEventListener('input', autoGrow);

  sendBtn.addEventListener('click', send);
  questionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  clearBtn.addEventListener('click', () => {
    messagesEl.innerHTML = EMPTY_STATE_HTML;
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
    } else if (message.type === 'userMessage') {
      addMessage(message.text, 'user');
      thinkingEl = addMessage('Thinking...', 'assistant thinking');
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

/**
 * Converts persisted chat history into a bounded message array suitable for
 * the model's `messages` field, then appends the current turn's full prompt.
 *
 * Bounding rules (see MAX_CONTEXT_* constants):
 * - Only the most recent MAX_CONTEXT_TURNS prior messages are considered.
 * - Each replayed message is capped at MAX_CONTEXT_ENTRY_CHARS.
 * - The combined size of all replayed messages is capped at
 *   MAX_CONTEXT_TOTAL_CHARS; if exceeded, the OLDEST kept turns are dropped
 *   first (we walk from most-recent backwards and stop once the budget is
 *   used up), so recent context is preserved over older context.
 * - If dropping messages leaves a leading assistant message with no
 *   preceding user message, that dangling leading message is dropped too,
 *   so the conversation always opens on a user turn.
 */
function buildConversationMessages(
  priorHistory: ChatHistoryEntry[],
  currentPrompt: string
): ConversationMessage[] {
  const recent = priorHistory.slice(-MAX_CONTEXT_TURNS);

  const kept: ConversationMessage[] = [];
  let totalChars = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    let content = entry.text;
    if (content.length > MAX_CONTEXT_ENTRY_CHARS) {
      content = content.slice(0, MAX_CONTEXT_ENTRY_CHARS) + '\n...(truncated for context)';
    }
    if (totalChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
      break; // budget used up; remaining (older) entries are dropped
    }
    totalChars += content.length;
    kept.unshift({ role: entry.sender === 'user' ? 'user' : 'assistant', content });
  }

  while (kept.length > 0 && kept[0].role !== 'user') {
    kept.shift();
  }

  kept.push({ role: 'user', content: currentPrompt });
  return kept;
}

async function askGroq(messages: ConversationMessage[], map: ProjectMap, apiKey: string): Promise<string> {
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
        ...messages
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