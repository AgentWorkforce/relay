/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // This repo intentionally uses a few tight loops (e.g., streaming parsers).
    'no-constant-condition': 'off',
    // Regex/string escaping in protocol/state templates can appear "redundant" to ESLint.
    'no-useless-escape': 'off',
    // Useful signal, but too noisy for this early release.
    '@typescript-eslint/no-explicit-any': 'off',
    // Empty interfaces / empty object types are common patterns in this codebase.
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-empty-interface': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/naming-convention': [
      'warn',
      {
        selector: 'variable',
        format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
        leadingUnderscore: 'allow',
      },
      {
        selector: 'typeLike',
        format: ['PascalCase'],
      },
    ],
    complexity: ['warn', 15],
    'max-depth': ['warn', 4],
    // Benchmark and cleanup code intentionally uses empty catch blocks.
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  ignorePatterns: ['dist/**', 'node_modules/**', 'coverage/**', '**/out/**'],
};
