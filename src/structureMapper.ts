import { DirEntry, FileEntry, FolderRole } from './types';

const ROLE_PATTERNS: { pattern: RegExp; role: string }[] = [
  { pattern: /^(components|views|screens|pages)$/i, role: 'UI / Presentation layer' },
  { pattern: /^(routes|controllers|api|endpoints)$/i, role: 'Routing / API layer' },
  { pattern: /^(models|entities|schemas|domain)$/i, role: 'Data models' },
  { pattern: /^(services|lib|core|logic)$/i, role: 'Business logic / services' },
  { pattern: /^(middleware|guards|interceptors)$/i, role: 'Middleware' },
  { pattern: /^(migrations|seeders|seeds)$/i, role: 'Database migrations/seeds' },
  { pattern: /^(tests?|__tests__|spec)$/i, role: 'Tests' },
  { pattern: /^(public|static|assets)$/i, role: 'Static assets' },
  { pattern: /^(hooks)$/i, role: 'React hooks' },
  { pattern: /^(store|redux|context)$/i, role: 'State management' },
  { pattern: /^(config|configs|settings)$/i, role: 'Configuration' },
  { pattern: /^(utils|helpers)$/i, role: 'Utilities' }
];

function classifyFolderName(name: string): string | null {
  for (const { pattern, role } of ROLE_PATTERNS) {
    if (pattern.test(name)) return role;
  }
  return null;
}

function countFiles(node: DirEntry): number {
  let count = 0;
  for (const child of node.children) {
    if ('children' in child) count += countFiles(child);
    else count += 1;
  }
  return count;
}

export function mapStructure(tree: DirEntry): FolderRole[] {
  const roles: FolderRole[] = [];

  function recurse(node: DirEntry) {
    const role = classifyFolderName(node.name);
    if (role) {
      const files = node.children.filter((c): c is FileEntry => !('children' in c));
      roles.push({
        path: node.path,
        role,
        fileCount: countFiles(node),
        sampleFiles: files.slice(0, 3).map(f => f.name)
      });
    }
    node.children.forEach(child => {
      if ('children' in child) recurse(child);
    });
  }

  recurse(tree);
  return roles;
}
