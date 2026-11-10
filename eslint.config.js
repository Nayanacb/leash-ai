import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'apps/server/src/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // ── Server ──────────────────────────────────────────────────────────────
  {
    files: ['apps/server/**/*.ts', 'packages/shared/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    rules: {
      // Payment credentials must only be read through the validated config, never ad hoc.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through src/config/env.ts (validated, sandbox-guarded).',
        },
      ],
    },
  },
  {
    // The entrypoint and config loader are the only places allowed to read process.env.
    files: ['apps/server/src/index.ts', 'apps/server/src/config/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // ARCHITECTURE.md §2.2 / invariant I7: the deterministic authorization engine
    // must never depend on the AI evaluation pipeline or the LLM client.
    files: [
      'apps/server/src/modules/authorization/**/*.ts',
      'apps/server/src/modules/budget/**/*.ts',
      // Payments are authorized by the deterministic engine only.
      'apps/server/src/modules/payments/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/evaluation',
                '**/evaluation/**',
                '**/llm',
                '**/llm/**',
                '@anthropic-ai/*',
              ],
              message:
                'The deterministic authorization engine must not import the AI pipeline or LLM client. ' +
                'Consume the validated AiSignals value instead (docs/ARCHITECTURE.md §2.2).',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the payments module may talk to PayPal.
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/modules/payments/**', 'apps/server/src/config/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/paypal\\.com/i]',
          message:
            'PayPal URLs belong only in src/modules/payments (and the sandbox guard in src/config).',
        },
      ],
    },
  },

  // ── Web ─────────────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'Never render raw HTML. Agent-supplied text is untrusted (docs/ARCHITECTURE.md §7).',
        },
      ],
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
