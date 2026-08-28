import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".wrangler/**"],
  },
  {
    files: ["scripts/**/*.{mjs,ts}"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        process: "readonly",
      },
    },
  },
);
