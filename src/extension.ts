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

  const chatProvider = new ChatViewProvider(context.extensionUri, () => cachedMap, context.secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
  );

  const setKeyDisposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.setApiKey',
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key (starts with sk-ant-)',
        password: true,
        ignoreFocusOut: true
      });
      if (key) {
        await context.secrets.store('anthropicApiKey', key);
        vscode.window.showInformationMessage('Claude API key saved securely.');
      }
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
