import * as fs from 'fs';
import * as path from 'path';
import { StackInfo } from './types';

const SUBFOLDER_CANDIDATES = [
  'backend', 'server', 'api',
  'frontend', 'client', 'web'
];

function readJSONSafe(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function detectAt(
  dir: string,
  languages: Set<string>,
  frameworks: Set<string>,
  packageManagers: Set<string>
): boolean {
  let found = false;

  const pkgPath = path.join(dir, 'package.json');
  if (fileExists(pkgPath)) {
    found = true;
    packageManagers.add('npm');
    if (fileExists(path.join(dir, 'yarn.lock'))) packageManagers.add('yarn');
    if (fileExists(path.join(dir, 'pnpm-lock.yaml'))) packageManagers.add('pnpm');

    const pkg = readJSONSafe(pkgPath);
    if (pkg) {
      const deps: Record<string, string> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      languages.add('JavaScript');
      if (fileExists(path.join(dir, 'tsconfig.json'))) languages.add('TypeScript');

      if (deps['next']) frameworks.add('Next.js');
      else if (deps['react']) frameworks.add('React');
      if (deps['vue']) frameworks.add('Vue');
      if (deps['@angular/core']) frameworks.add('Angular');
      if (deps['express']) frameworks.add('Express');
      if (deps['fastify']) frameworks.add('Fastify');
      if (deps['@nestjs/core']) frameworks.add('NestJS');
      if (deps['electron']) frameworks.add('Electron');
    }
  }

  const reqPath = path.join(dir, 'requirements.txt');
  const pyprojectPath = path.join(dir, 'pyproject.toml');
  const setupPyPath = path.join(dir, 'setup.py');
  const pipfilePath = path.join(dir, 'Pipfile');
  if (fileExists(reqPath) || fileExists(pyprojectPath) || fileExists(setupPyPath) || fileExists(pipfilePath)) {
    found = true;
    languages.add('Python');
    if (fileExists(pyprojectPath)) packageManagers.add('poetry');
    else if (fileExists(pipfilePath)) packageManagers.add('pipenv');
    else packageManagers.add('pip');

    const combined = (
      (fileExists(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : '') +
      (fileExists(pyprojectPath) ? fs.readFileSync(pyprojectPath, 'utf-8') : '')
    ).toLowerCase();
    if (combined.includes('django')) frameworks.add('Django');
    if (combined.includes('flask')) frameworks.add('Flask');
    if (combined.includes('fastapi')) frameworks.add('FastAPI');
    if (combined.includes('sqlalchemy')) frameworks.add('SQLAlchemy');
    if (combined.includes('alembic') || fileExists(path.join(dir, 'alembic.ini'))) frameworks.add('Alembic');
  }

  const composerPath = path.join(dir, 'composer.json');
  if (fileExists(composerPath)) {
    found = true;
    languages.add('PHP');
    packageManagers.add('composer');
    const composer = readJSONSafe(composerPath);
    if (composer) {
      const deps: Record<string, string> = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
      if (deps['laravel/framework']) frameworks.add('Laravel');
    }
  }

  if (fileExists(path.join(dir, 'go.mod'))) { languages.add('Go'); found = true; }
  if (fileExists(path.join(dir, 'Cargo.toml'))) { languages.add('Rust'); found = true; }
  if (fileExists(path.join(dir, 'pom.xml')) || fileExists(path.join(dir, 'build.gradle'))) {
    languages.add('Java');
    found = true;
  }

  return found;
}

export function detectStack(rootPath: string): StackInfo {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const notes: string[] = [];

  const rootFound = detectAt(rootPath, languages, frameworks, packageManagers);

  const subfoldersFound: string[] = [];
  for (const name of SUBFOLDER_CANDIDATES) {
    const subDir = path.join(rootPath, name);
    if (isDirectory(subDir) && detectAt(subDir, languages, frameworks, packageManagers)) {
      subfoldersFound.push(name);
    }
  }

  if (!rootFound && subfoldersFound.length === 0) {
    notes.push('No standard manifest file found at project root or common subfolders - stack detection may be incomplete.');
  } else if (subfoldersFound.length > 0) {
    notes.push('Monorepo detected - stack info also pulled from: ' + subfoldersFound.join(', '));
  }

  return {
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    packageManagers: Array.from(packageManagers),
    notes
  };
}