// ESLint の設定（npm run lint）。アプリの JS（public/js/・easy.js）は ES モジュール、単体テストは Node の ES モジュール
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['public/js/**/*.js', 'public/easy.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['tools/test/unit/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node }
  }
];
