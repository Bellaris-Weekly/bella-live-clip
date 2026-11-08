import js from '@eslint/js';
import globals from 'globals';

export default [
  {ignores: ['bella-live-clip.user.js', 'bella-live-clip.preview.user.js', 'node_modules/', '.wrangler/', '.local/']},
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        __LOG_SERVICE_ENDPOINT__: 'readonly',
        __PREVIEW__: 'readonly',
        GM_getValue: 'readonly',
        GM_registerMenuCommand: 'readonly',
        GM_setValue: 'readonly',
        GM_xmlhttpRequest: 'readonly',
        unsafeWindow: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {caughtErrors: 'none', ignoreRestSiblings: true}],
      'no-constant-condition': ['error', {checkLoops: false}],
    },
  },
  {files: ['tools/**', '*.mjs'], languageOptions: {globals: {...globals.node, ...globals.browser}}},
];
