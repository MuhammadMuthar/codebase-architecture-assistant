import * as fs from 'fs';
import * as path from 'path';
import { StackInfo } from './types';

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

export function detectStack(rootPath: string): StackInfo {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const notes: string[] = [];

  // --- Node / JS / TS ecosystem ---
  const pkgPath = path.join(rootPath, 'package.json');
  if (fileExists(pkgPath)) {
    packageManagers.add('npm');
    if (fileExists(path.join(rootPath, 'yarn.lock'))) packageManagers.add('yarn');
    if (fileExists(path.join(rootPath, 'pnpm-lock.yaml'))) packageManagers.add('pnpm');

    const pkg = readJSONSafe(pkgPath);
    if (pkg) {
      const deps: Record<string, string> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      languages.add('JavaScript');
      if (fileExists(path.join(rootPath, 'tsconfig.json'))) languages.add('TypeScript');

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

  // --- Python ecosystem ---
  const reqPath = path.join(rootPath, 'requirements.txt');
  const pyprojectPath = path.join(rootPath, 'pyproject.toml');
  if (fileExists(reqPath) || fileExists(pyprojectPath)) {
    languages.add('Python');
    packageManagers.add(fileExists(pyprojectPath) ? 'poetry' : 'pip');
    const combined = (
      (fileExists(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : '') +
      (fileExists(pyprojectPath) ? fs.readFileSync(pyprojectPath, 'utf-8') : '')
    ).toLowerCase();
    if (combined.includes('django')) frameworks.add('Django');
    if (combined.includes('flask')) frameworks.add('Flask');
    if (combined.includes('fastapi')) frameworks.add('FastAPI');
  }

  // --- PHP ecosystem ---
  const composerPath = path.join(rootPath, 'composer.json');
  if (fileExists(composerPath)) {
    languages.add('PHP');
    packageManagers.add('composer');
    const composer = readJSONSafe(composerPath);
    if (composer) {
      const deps: Record<string, string> = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
      if (deps['laravel/framework']) frameworks.add('Laravel');
    }
  }

  // --- Other quick signals ---
  if (fileExists(path.join(rootPath, 'go.mod'))) languages.add('Go');
  if (fileExists(path.join(rootPath, 'Cargo.toml'))) languages.add('Rust');
  if (fileExists(path.join(rootPath, 'pom.xml')) || fileExists(path.join(rootPath, 'build.gradle'))) languages.add('Java');

  if (languages.size === 0) {
    notes.push('No standard manifest file found at project root - stack detection may be incomplete, or this is a monorepo with manifests in subfolders.');
  }

  return {
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    packageManagers: Array.from(packageManagers),
    notes
  };
}
