/**
 * ESLint config: recommended rules for the extension (browser ES modules
 * with chrome.* APIs) and for the Node/Vitest tooling around it.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['extension/popup.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['tests/**/*.js', '*.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-shadow': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
];
