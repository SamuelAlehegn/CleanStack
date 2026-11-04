import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/**', 'web/dist/**', 'node_modules/**'],
});
