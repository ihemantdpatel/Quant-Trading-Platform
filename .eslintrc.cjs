/**
 * Shared base config. `backend/.eslintrc.cjs` and `ui/.eslintrc.cjs` extend this
 * so lint rules stay identical across the two packages, which are otherwise
 * independent npm projects (compose builds them as separate images).
 *
 * `parser` is resolved to an absolute path rather than named as a bare string:
 * eslintrc resolves plugins relative to the config that declares them, and this
 * file sits at the repo root where nothing is installed. `require.resolve` runs
 * in the *extending* package's context, so each finds its own copy.
 */
module.exports = {
  root: true,
  parser: require.resolve('@typescript-eslint/parser'),
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  ignorePatterns: ['node_modules', 'dist', 'coverage', '.next', '*.cjs'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'off',
  },
};
