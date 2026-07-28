import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapStructure } from '../structureMapper';
import { DirEntry, FileEntry } from '../types';

function file(name: string, relPath: string): FileEntry {
  return { path: relPath, name, ext: '.' + name.split('.').pop(), size: 10 };
}

function dir(name: string, relPath: string, children: (DirEntry | FileEntry)[]): DirEntry {
  return { path: relPath, name, children };
}

describe('structureMapper', () => {
  test('classifies known folder names into their expected roles', () => {
    const tree = dir('root', '.', [
      dir('components', 'components', [file('Button.tsx', 'components/Button.tsx')]),
      dir('routes', 'routes', [file('users.ts', 'routes/users.ts')]),
      dir('models', 'models', [file('User.ts', 'models/User.ts')]),
      dir('utils', 'utils', [file('format.ts', 'utils/format.ts')])
    ]);

    const roles = mapStructure(tree);
    const roleByPath = Object.fromEntries(roles.map(r => [r.path, r.role]));

    assert.equal(roleByPath['components'], 'UI / Presentation layer');
    assert.equal(roleByPath['routes'], 'Routing / API layer');
    assert.equal(roleByPath['models'], 'Data models');
    assert.equal(roleByPath['utils'], 'Utilities');
  });

  test('classification is case-insensitive', () => {
    const tree = dir('root', '.', [
      dir('Components', 'Components', [])
    ]);
    const roles = mapStructure(tree);
    assert.equal(roles[0].role, 'UI / Presentation layer');
  });

  test('ignores folders that do not match any known role', () => {
    const tree = dir('root', '.', [
      dir('some-random-folder', 'some-random-folder', [file('a.ts', 'some-random-folder/a.ts')])
    ]);
    const roles = mapStructure(tree);
    assert.equal(roles.length, 0);
  });

  test('fileCount includes files from nested subfolders, not just direct children', () => {
    const tree = dir('root', '.', [
      dir('services', 'services', [
        file('a.ts', 'services/a.ts'),
        dir('nested', 'services/nested', [
          file('b.ts', 'services/nested/b.ts'),
          file('c.ts', 'services/nested/c.ts')
        ])
      ])
    ]);
    const roles = mapStructure(tree);
    assert.equal(roles[0].role, 'Business logic / services');
    assert.equal(roles[0].fileCount, 3);
  });

  test('sampleFiles only includes direct-child files, capped at 3, in original order', () => {
    const tree = dir('root', '.', [
      dir('utils', 'utils', [
        file('a.ts', 'utils/a.ts'),
        file('b.ts', 'utils/b.ts'),
        file('c.ts', 'utils/c.ts'),
        file('d.ts', 'utils/d.ts')
      ])
    ]);
    const roles = mapStructure(tree);
    assert.deepEqual(roles[0].sampleFiles, ['a.ts', 'b.ts', 'c.ts']);
  });

  test('recurses into matched folders to find further matches beneath them', () => {
    const tree = dir('root', '.', [
      dir('src', 'src', [
        dir('components', 'src/components', [file('Card.tsx', 'src/components/Card.tsx')]),
        dir('services', 'src/services', [file('api.ts', 'src/services/api.ts')])
      ])
    ]);
    const roles = mapStructure(tree);
    const paths = roles.map(r => r.path).sort();
    assert.deepEqual(paths, ['src/components', 'src/services']);
  });

  test('returns an empty array for a tree with no recognizable folders at all', () => {
    const tree = dir('root', '.', [file('index.js', 'index.js')]);
    const roles = mapStructure(tree);
    assert.deepEqual(roles, []);
  });
});
