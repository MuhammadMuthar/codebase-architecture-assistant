import * as vscode from 'vscode';
import { scanDirectory, flattenFiles } from './scanner';
import { detectStack } from './stackDetector';
import { mapStructure } from './structureMapper';
import { ProjectMap } from './types';
import { ChatViewProvider } from './chatViewProvider';

let cachedMap: ProjectMap | undefined;

// Keeps a single file/selection prompt from blowing up token usage or cost.
const MAX_SNIPPET_CHARS = 6000;

function truncate(content: string): string {
  return content.length > MAX_SNIPPET_CHARS
    ? content.slice(0, MAX_SNIPPET_CHARS) + '\n... (truncated, file is longer)'
    : content;
}

function buildProjectMap(rootPath: string): ProjectMap {
  const tree = scanDirectory(rootPath);
  const allFiles = flattenFiles(tree);
  const stack = detectStack(rootPath, allFiles);
  const structure = mapStructure(tree);
  return { root: rootPath, stack, structure, fileTree: tree, totalFiles: allFiles.length };
}

async function scanWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    cachedMap = undefined;
    return;
  }

  const rootPath = folders[0].uri.fsPath;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Codebase Assistant: scanning project...'
    },
    async () => {
      cachedMap = buildProjectMap(rootPath);
      console.log('Project map built:', cachedMap.stack);
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  // Fire-and-forget: don't block activate() on a potentially large scan.
  // Anything that reads cachedMap already handles the "not ready yet" case.
  void scanWorkspace();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void scanWorkspace();
    })
  );

  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    () => cachedMap,
    context.secrets,
    context.globalState,
    context.workspaceState,
    vscode.env.machineId
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const setKeyDisposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.setApiKey',
    async () => {
      const existingKey = await context.secrets.get('groqApiKey');
      const key = await vscode.window.showInputBox({
        prompt: existingKey
          ? 'Enter your Groq API key (starts with gsk_) - leave empty to keep the saved key'
          : 'Enter your Groq API key (starts with gsk_)',
        password: true,
        ignoreFocusOut: true
      });

      if (key === undefined) {
        // User pressed Esc - abort, no message needed.
        return;
      }

      const trimmed = key.trim();
      if (trimmed === '') {
        if (existingKey) {
          vscode.window.showInformationMessage('Keeping existing Groq API key.');
        } else {
          vscode.window.showWarningMessage('No key entered and none saved yet - Groq API key was not set.');
        }
        return;
      }

      await context.secrets.store('groqApiKey', trimmed);
      vscode.window.showInformationMessage('Groq API key saved securely.');
    }
  );
  context.subscriptions.push(setKeyDisposable);

  const clearKeyDisposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.clearApiKey',
    async () => {
      const existingKey = await context.secrets.get('groqApiKey');
      if (!existingKey) {
        vscode.window.showInformationMessage('No Groq API key is currently saved.');
        return;
      }
      await context.secrets.delete('groqApiKey');
      vscode.window.showInformationMessage('Groq API key cleared. You will now use the free-tier proxy.');
    }
  );
  context.subscriptions.push(clearKeyDisposable);

  const disposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.showMap',
    () => {
      if (!cachedMap) {
        vscode.window.showInformationMessage('No project map yet - open a folder first.');
        return;
      }
      const { languages, frameworks } = cachedMap.stack;
      vscode.window.showInformationMessage(
        `Stack: ${languages.join(', ') || 'unknown'} | ${frameworks.join(', ') || 'no frameworks detected'} | ${cachedMap.totalFiles} files`
      );
    }
  );

  context.subscriptions.push(disposable);

  const askAboutFileDisposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.askAboutFile',
    async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        vscode.window.showWarningMessage('No file selected.');
        return;
      }

      let content: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(targetUri);
        content = Buffer.from(bytes).toString('utf8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Could not read file: ${msg}`);
        return;
      }

      const relPath = vscode.workspace.asRelativePath(targetUri);
      const prompt = [
        `File: ${relPath}`,
        '',
        '```',
        truncate(content),
        '```',
        '',
        'Explain what this file does and how it likely fits into the rest of the project.'
      ].join('\n');

      await chatProvider.askExternally(`Explain ${relPath}`, prompt);
    }
  );
  context.subscriptions.push(askAboutFileDisposable);

  const explainSelectionDisposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.explainSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first.');
        return;
      }

      const selectedText = editor.document.getText(editor.selection);
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const prompt = [
        `Selected code from ${relPath}:`,
        '',
        '```',
        truncate(selectedText),
        '```',
        '',
        'Explain what this code does.'
      ].join('\n');

      await chatProvider.askExternally(`Explain selected code in ${relPath}`, prompt);
    }
  );
  context.subscriptions.push(explainSelectionDisposable);
}

export function deactivate() {}