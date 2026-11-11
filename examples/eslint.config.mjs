// Opt-in only: adapt into the host repository's existing ESLint configuration.
// The KSD style profile as blocking errors, suited to lint-staged. The TypeScript block needs
// typescript-eslint installed in the host; plain JavaScript repositories can drop it.
import tseslint from "typescript-eslint";
import engineeringProxy from "omp-engineering-proxy/eslint";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
    plugins: { "engineering-proxy": engineeringProxy },
    rules: {
      "engineering-proxy/blank-before-return": "error",
      "engineering-proxy/blank-between-functions": "error",
      "engineering-proxy/prefer-guard-clauses": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-nested-ternary": "error",
      "max-depth": ["error", 3],
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },
];
