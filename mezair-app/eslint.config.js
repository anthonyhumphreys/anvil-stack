import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const globals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  document: 'readonly',
  Electron: 'readonly',
  fetch: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  globalThis: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  KeyboardEvent: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  NodeJS: 'readonly',
  process: 'readonly',
  React: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  window: 'readonly',
};

export default [
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'video/**', 'landing/**', 'mobile/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-constant-binary-expression': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  {
    // DS3: semantic colour tokens. Raw amber/emerald/red/green palette classes
    // bypass the theme tokens; use warning/success/error instead. Categorical
    // multi-hue palettes (severity scales, chart colours) are out of scope.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            'Literal[raw=/\\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|caret|accent|decoration|shadow)-(?:amber|emerald|red|green)-[0-9]/]',
          message:
            'Use semantic colour tokens (warning/success/error) instead of raw amber/emerald/red/green palette classes.',
        },
        {
          selector:
            'TemplateElement[value.raw=/\\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|caret|accent|decoration|shadow)-(?:amber|emerald|red|green)-[0-9]/]',
          message:
            'Use semantic colour tokens (warning/success/error) instead of raw amber/emerald/red/green palette classes.',
        },
      ],
    },
  },
];
