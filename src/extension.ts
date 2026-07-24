import * as vscode from 'vscode';
import { scanDirectory, flattenFiles } from './scanner';
import { detectStack } from './stackDetector';
import { mapStructure } from './structureMapper';
import { ProjectMap } from './types';

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

  const disposable = vscode.commands.registerCommand(
    'codebase-architecture-assistant.showMap',
    () => {
      if (!cachedMap) {
        vscode.window.showInformationMessage('No project map yet — open a folder first.');
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