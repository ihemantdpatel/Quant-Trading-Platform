module.exports = {
  extends: ['../.eslintrc.cjs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    node: true,
  },
};
