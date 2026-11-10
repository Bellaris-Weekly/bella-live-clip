import js from '@eslint/js';
import globals from 'globals';

// Core scope analysis does not count <Component /> as a use of Component.
const jsxUsesVars = {
  meta: {type: 'problem', schema: []},
  create: context => ({
    JSXOpeningElement(node) {
      let name = node.name;
      while (name.type === 'JSXMemberExpression') name = name.object;
      if (name.type === 'JSXIdentifier' && /^[A-Z]/.test(name.name))
        context.sourceCode.markVariableAsUsed(name.name, node);
    },
  }),
};

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
        GM_addValueChangeListener: 'readonly',
        GM_listValues: 'readonly',
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
  {
    files: ['**/*.jsx'],
    languageOptions: {parserOptions: {ecmaFeatures: {jsx: true}}},
    plugins: {local: {rules: {'jsx-uses-vars': jsxUsesVars}}},
    rules: {'local/jsx-uses-vars': 'error'},
  },
  {files: ['tools/**', '*.mjs'], languageOptions: {globals: {...globals.node, ...globals.browser}}},
];
