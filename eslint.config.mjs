/**
 * ESLint flat config.
 *
 * Baseline = eslint:recommended + typescript-eslint recommended + React rules
 * for the renderer, with the formatting delegated to Prettier (see
 * .prettierrc.json). The interesting choices:
 *
 *  - `no-undef` is off for TS files: the compiler already checks this, and
 *    duplicating it here would require maintaining two sets of globals for
 *    main / renderer. The sandbox contract is enforced by tsconfig instead
 *    (renderer tsconfig has no "node" types).
 *  - `no-console` warns (allowing warn/error/info): the main process logs
 *    deliberately, but a stray `console.log` debug leftover still shows up.
 *  - renderer files get NO Node globals, mirroring `sandbox: true`.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/** Globals legitimately available to the Node-side scripts (.mjs tooling). */
const scriptGlobals = {
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly'
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'tests/fixtures/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- Node-side scripts (dev.mjs / build-main.mjs) -------------------------
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: scriptGlobals
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },

  // --- TypeScript (all layers) ----------------------------------------------
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // tsc owns undefined-identifier checking for TS files.
      'no-undef': 'off',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },

  // --- Renderer (React) ------------------------------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: 'detect' } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // New JSX transform: React does not need to be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // Keep Prettier's formatting choices out of ESLint's way. Must be last.
  prettier
)
