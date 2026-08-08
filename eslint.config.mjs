// Flat config, replacing .eslintrc.json's `next/core-web-vitals` now that Next
// is gone. The rule set is carried over unchanged; react-hooks is kept because
// the gesture/spring code leans on exhaustive-deps being enforced.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      '.next-build/**',
      // Standalone Node utilities (OG capture, ad-hoc probes), CommonJS by
      // design and never bundled. `next lint` never saw them either.
      'scripts/**',
      '.wrangler/**',
      '.context/**',
      'src/routeTree.gen.ts',
      'worker-configuration.d.ts',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Just the two rules next/core-web-vitals enforced. This plugin's own
      // `recommended` now also turns on the React Compiler rule set, which
      // flags ~5,700 things in this codebase (mostly refs-during-render in the
      // canvas and gesture paths). Adopting that is a real piece of work and a
      // decision in its own right — not something to slip into a runtime
      // migration.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description' },
      ],
    },
  },
);
