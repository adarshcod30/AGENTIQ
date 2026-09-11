/**
 * ESLint 9 flat config.
 *
 * Deliberately small. The rules that matter architecturally are enforced by
 * tests/architecture.test.js, not by lint: a test failure is unambiguous and
 * runs in CI on every push, whereas a lint rule is easy to disable inline.
 */
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        // Node 18+ global; used for request timeouts in services/mailer.service.js.
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      // caughtErrors defaults to 'all' in ESLint 9, and argsIgnorePattern does
      // NOT cover catch clauses: they need their own pattern. Without this,
      // `catch (_err)` is still reported as unused.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off', // the env boot table and migration script print by design
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', vi: 'readonly',
      },
    },
  },
];
