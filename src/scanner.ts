import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, DirEntry } from './types';

// Folders we never want to walk into.
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor',
  '__pycache__', 'venv', 'coverage'
]);

function shouldSkipDir(name: string): boolean {
  if (IGNORE_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true; // .git, .vscode, .idea, .next, etc.
  return false;
}

export function scanDirectory(rootPath: string): DirEntry {
  function walk(currentPath: string, relativePath: string): DirEntry {
    const name = path.basename(currentPath) || currentPath;
    const children: (DirEntry | FileEntry)[] = [];

    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        const childPath = path.join(currentPath, entry.name);
        const childRelative = path.join(relativePath, entry.name);
        children.push(walk(childPath, childRelative));
      } else if (entry.isFile()) {
        const fullPath = path.join(currentPath, entry.name);
        const stat = fs.statSync(fullPath);
        children.push({
          path: path.join(relativePath, entry.name),
          name: entry.name,
          ext: path.extname(entry.name),
          size: stat.size
        });
      }
    }

    return { path: relativePath || '.', name, children };
  }

  return walk(rootPath, '');
}

export function flattenFiles(tree: DirEntry): FileEntry[] {
  const files: FileEntry[] = [];
  function recurse(node: DirEntry | FileEntry) {
    if ('children' in node) {
      node.children.forEach(recurse);
    } else {
      files.push(node);
    }
  }
  recurse(tree);
  return files;
}
