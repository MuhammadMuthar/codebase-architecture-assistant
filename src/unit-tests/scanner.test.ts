import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanDirectory, flattenFiles } from '../scanner';

describe('scanner', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));

    // A normal source file at the root.
    fs.writeFileSync(path.join(tmpDir, 'index.js'), 'console.log(1);');

    // A nested folder that should be walked.
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.test.ts'), 'export {};');

    // Folders that should be ignored entirely.
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'some-pkg', 'index.js'), '// dep');

    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), '// built output');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('walks nested folders and includes files at every level', () => {
    const tree = scanDirectory(tmpDir);
    const files = flattenFiles(tree);
    const names = files.map(f => f.name).sort();

    assert.deepEqual(names, ['app.test.ts', 'app.ts', 'index.js']);
  });

  test('skips node_modules, dotfolders, and build output directories', () => {
    const tree = scanDirectory(tmpDir);
    const files = flattenFiles(tree);
    const paths = files.map(f => f.path);

    assert.ok(!paths.some(p => p.includes('node_modules')));
    assert.ok(!paths.some(p => p.includes('.git')));
    assert.ok(!paths.some(p => p.includes('dist')));
  });

  test('records correct extension and relative path for nested files', () => {
    const tree = scanDirectory(tmpDir);
    const files = flattenFiles(tree);
    const appTs = files.find(f => f.name === 'app.ts');

    assert.ok(appTs, 'expected to find src/app.ts');
    assert.equal(appTs!.ext, '.ts');
    assert.equal(appTs!.path, path.join('src', 'app.ts'));
  });

  test('root DirEntry uses the folder name and empty relative path', () => {
    const tree = scanDirectory(tmpDir);
    assert.equal(tree.path, '.');
    assert.equal(tree.name, path.basename(tmpDir));
  });
});
