import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules are chosen for the failure modes this system actually has, not for
 * style. A codebase that spends money and dials strangers has two categories
 * worth a machine's attention: a promise nobody awaited, and a value nobody
 * checked. Formatting arguments are left to the reader.
 */
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'data/**', 'assets/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // This file is not in tsconfig's program, so it needs the default
        // project or the parser rejects it before any rule gets to run.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The ones that catch real defects here. Nearly every write in this
      // codebase is async and side-effectful - an unawaited publish, dispatch
      // or upload fails silently and the run carries on as if it worked.
      // node:test's own `test()` returns a promise the runner owns; awaiting it
      // is wrong. Everything else in a test body is still held to the rule,
      // because an unawaited promise inside a test is a genuine bug.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe'], package: 'node:test' }] },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      // Provider responses and webhook bodies are `any` until proven otherwise.
      // These keep that from spreading silently into the domain types.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Deliberate: the mocks and the CLI take parameters they do not use,
      // because they implement an interface someone else defined.
      'no-empty-pattern': 'off',
    },
  },

  {
    // The mocks implement an async provider interface synchronously - that is
    // exactly what they are for. `require-await` cannot tell interface
    // conformance from a forgotten await, and here it is always the former.
    files: ['src/**/mock.ts', 'src/creative/library.ts', 'src/creative/rendered.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  {
    // Tests reach into internals and hand deliberately malformed payloads to
    // handlers. That is the job; the type escape hatches are the point.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
