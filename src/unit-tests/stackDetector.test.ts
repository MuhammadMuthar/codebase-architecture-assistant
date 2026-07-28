import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectStack } from '../stackDetector';
import { scanDirectory, flattenFiles } from '../scanner';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('stackDetector - manifest-based detection', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir('stack-react-');
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } })
    );
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('detects React + npm from package.json and adds no warning notes', () => {
    const stack = detectStack(tmpDir);
    assert.ok(stack.languages.includes('JavaScript'));
    assert.ok(stack.frameworks.includes('React'));
    assert.ok(stack.packageManagers.includes('npm'));
    assert.deepEqual(stack.notes, []);
  });

  test('detects TypeScript when tsconfig.json is present alongside package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
    const stack = detectStack(tmpDir);
    assert.ok(stack.languages.includes('TypeScript'));
  });
});

describe('stackDetector - Python manifest detection', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir('stack-python-');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'Django==4.2\ngunicorn==21.0');
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('detects Django from requirements.txt', () => {
    const stack = detectStack(tmpDir);
    assert.ok(stack.languages.includes('Python'));
    assert.ok(stack.frameworks.includes('Django'));
    assert.ok(stack.packageManagers.includes('pip'));
  });
});

describe('stackDetector - plain static site fallback (no manifest)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir('stack-static-');
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body {}');
    fs.writeFileSync(path.join(tmpDir, 'script.js'), 'console.log(1);');
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('falls back to extension-based detection and reports HTML/CSS/JavaScript', () => {
    const tree = scanDirectory(tmpDir);
    const files = flattenFiles(tree);
    const stack = detectStack(tmpDir, files);

    assert.ok(stack.languages.includes('HTML'));
    assert.ok(stack.languages.includes('CSS'));
    assert.ok(stack.languages.includes('JavaScript'));
    assert.equal(stack.frameworks.length, 0);
    assert.equal(stack.packageManagers.length, 0);
    assert.ok(stack.notes.some(n => n.toLowerCase().includes('static site')));
  });

  test('without a files argument, falls back to the generic "incomplete" note', () => {
    // Simulates a caller that forgets to pass the scanned file list.
    const stack = detectStack(tmpDir);
    assert.deepEqual(stack.languages, []);
    assert.ok(stack.notes.some(n => n.includes('may be incomplete')));
  });
});

describe('stackDetector - truly unknown project', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir('stack-unknown-');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Just a readme');
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('reports empty stack and an "incomplete" note when nothing is recognizable', () => {
    const tree = scanDirectory(tmpDir);
    const files = flattenFiles(tree);
    const stack = detectStack(tmpDir, files);

    assert.deepEqual(stack.languages, []);
    assert.deepEqual(stack.frameworks, []);
    assert.ok(stack.notes.some(n => n.includes('No standard manifest file found')));
  });
});

describe('stackDetector - monorepo across known subfolders', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTmpDir('stack-monorepo-');
    fs.mkdirSync(path.join(tmpDir, 'backend'));
    fs.writeFileSync(
      path.join(tmpDir, 'backend', 'package.json'),
      JSON.stringify({ name: 'api', dependencies: { express: '^4.0.0' } })
    );
    fs.mkdirSync(path.join(tmpDir, 'frontend'));
    fs.writeFileSync(
      path.join(tmpDir, 'frontend', 'package.json'),
      JSON.stringify({ name: 'web', dependencies: { react: '^18.0.0' } })
    );
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('pulls stack info from recognized subfolders and notes it as a monorepo', () => {
    const stack = detectStack(tmpDir);
    assert.ok(stack.frameworks.includes('Express'));
    assert.ok(stack.frameworks.includes('React'));
    assert.ok(stack.notes.some(n => n.includes('Monorepo detected')));
  });
});
