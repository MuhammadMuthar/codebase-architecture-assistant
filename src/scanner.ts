import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, DirEntry } from './types';

// Folders we never want to walk into.
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor',
  '__pycache__', 'venv', 'coverage'
]);

// Hard ceiling on how many files we'll walk in one scan. Protects against
// hanging / ballooning memory on unusually large workspaces; beyond this the
// project map is built from a partial (but still representative) view of
// the tree rather than every single file.
const MAX_FILES = 20000;

function shouldSkipDir(name: string): boolean {
  if (IGNORE_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true; // .git, .vscode, .idea, .next, etc.
  return false;
}

export function scanDirectory(rootPath: string): DirEntry {
  let fileCount = 0;

  function walk(currentPath: string, relativePath: string): DirEntry {
    const name = path.basename(currentPath) || currentPath;
    const children: (DirEntry | FileEntry)[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      // Permission errors, broken paths, etc. - skip this directory rather
      // than aborting the whole scan.
      return { path: relativePath || '.', name, children };
    }

    for (const entry of entries) {
      if (fileCount >= MAX_FILES) break;

      // Symlinks are skipped entirely (both to files and directories) so a
      // symlink loop can never cause unbounded/infinite recursion.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        const childPath = path.join(currentPath, entry.name);
        const childRelative = path.join(relativePath, entry.name);
        children.push(walk(childPath, childRelative));
      } else if (entry.isFile()) {
        const fullPath = path.join(currentPath, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        children.push({
          path: path.join(relativePath, entry.name),
          name: entry.name,
          ext: path.extname(entry.name),
          size: stat.size
        });
        fileCount++;
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
