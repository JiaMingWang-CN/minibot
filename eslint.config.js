import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // 安卓工程里只有构建 / cap sync 生成的 JS
  { ignores: ['**/dist/**', '**/node_modules/**', '.codegraph/**', 'apps/mobile/android/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/renderer/src/**/*.{ts,tsx}', 'apps/mobile/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Electron 主进程是 CommonJS（.cts），只能用 require
    files: ['**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
