import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-test/**',
      'node_modules/**',
      'spikes/**',
      'src/policy/**',
      'tests/policy/**',
      'examples/**',
      '.gitnexus/**',
      '.omp/**',
      'coverage/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
