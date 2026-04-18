// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "node_modules/**",
      "testscripts/**",
      "integration/**",
    ],
  },
  {
    rules: {
      // Allow explicit `any` when intentional — prefer `unknown` for untyped boundaries
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused variables: ignore args prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
