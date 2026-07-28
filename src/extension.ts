import * as vscode from 'vscode';
import { scanDirectory, flattenFiles } from './scanner';
import { detectStack } from './stackDetector';
import { mapStructure } from './structureMapper';
import { ProjectMap } from './types';
import { ChatViewProvider } from './chatViewProvider';

let cachedMap: ProjectMap | undefined;

function buildProjectMap(rootPath: string): ProjectMap {
  const tree = scanDirectory(rootPath);
  const stack = detectStack(rootPath);
  const structure = mapStructure(tree);
  const totalFiles = flattenFiles(tree).length;
  return { root: rootPath, stack, structure, fileTree: tree, totalFiles };
}

export function activate(context: vscode.ExtensionContext) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const rootPath = folders[0].uri.fsPath;
    cachedMap = buildProjectMap(rootPath);
    console.log('Project map built:', cachedMap.stack);
  }

  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    () => cachedMap,
    context.secrets,
    context.globalState,
    vscode.env.machineId
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
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
}

export function deactivate() {}
