/**
 * The server compiles a handful of files out of `web/src` and runs them under Node.
 *
 * That makes their import specifiers a packaging concern rather than a style one.
 * Vite resolves `'./types'` happily, and so does TypeScript under
 * `moduleResolution: bundler`, so an extensionless relative import type-checks,
 * bundles and ships — and then Node's ESM loader, which requires the extension,
 * refuses it with a bare `ERR_MODULE_NOT_FOUND` at boot.
 *
 * This already happened once. `web/src/types.ts` re-exported `lensKey` without the
 * extension, which was harmless for as long as only the CLI exporter reached that
 * module; the day an HTTP route imported it, the server stopped starting. Nothing in
 * the type checker or the test suite noticed, because the failure is at import time
 * in the built output.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, describe } from 'node:test';

/** The tsconfig `include` list is the contract; these are the files it names. */
const COMPILED_FROM_WEB = [
  '../web/src/types.ts',
  '../web/src/links.ts',
  '../web/src/format.ts',
  '../web/src/snapshot-build.ts',
];

/** A relative import or re-export, capturing the specifier. */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;

describe('files the server runs under Node', () => {
  for (const file of COMPILED_FROM_WEB) {
    test(`${file} names every relative import with its extension`, () => {
      const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
      const bare = [...source.matchAll(RELATIVE_IMPORT)]
        .map((match) => match[1])
        .filter((specifier): specifier is string => typeof specifier === 'string')
        .filter((specifier) => !specifier.endsWith('.js') && !specifier.endsWith('.json'));

      assert.deepEqual(
        bare,
        [],
        `Node's ESM loader cannot resolve these, so the server will not boot: ${bare.join(', ')}`,
      );
    });
  }

  test('the tsconfig still names every web file the server imports', () => {
    // A file imported but not included compiles anyway, and then this list quietly
    // stops describing what ships. Keeping them in step is what makes the check above
    // mean anything.
    const tsconfig = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../tsconfig.json'), 'utf8'),
    ) as { include: string[] };

    for (const file of COMPILED_FROM_WEB) {
      assert.ok(
        tsconfig.include.includes(file),
        `${file} is checked here but missing from the server tsconfig's include`,
      );
    }
  });
});
