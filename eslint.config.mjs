import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default [...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    //"plugin:@typescript-eslint/recommended-requiring-type-checking",
), {
    ignores: [
        "dist/*",
        "node_modules",
        "eslint.config.mjs",
        "tsup.config.ts",
        "extractorpack.extconfig.js",
    ],
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2023,
        sourceType: "module",

        parserOptions: {
            project: "./tsconfig.json",
        },
    },

    rules: {
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-require-imports": "off",
        indent: ["error", 4, {
            SwitchCase: 1,
        }],

        semi: "error",
        "prefer-const": "error",
        "no-undef": "off",
        "no-unused-vars": "off",

        "arrow-spacing": ["warn", {
            before: true,
            after: true,
        }],

        "comma-dangle": ["error", "always-multiline"],
        "comma-spacing": "error",
        "comma-style": "error",
        curly: ["error", "multi-or-nest", "consistent"],
        "dot-location": ["error", "property"],
        "handle-callback-err": "off",
        "keyword-spacing": "error",

        "max-nested-callbacks": ["error", {
            max: 3,
        }],

        "max-statements-per-line": ["error", {
            max: 3,
        }],

        "no-console": "off",
        "no-empty-function": "error",
        "no-floating-decimal": "error",
        "no-lonely-if": "error",

        "no-multiple-empty-lines": ["error", {
            max: 2,
            maxEOF: 1,
            maxBOF: 0,
        }],

        "no-shadow": ["error", {
            allow: ["err", "error", "e", "resolve", "reject", "buffer"],
        }],

        "no-var": "error",
        "object-curly-spacing": ["error", "always"],
        quotes: ["error", "double"],
        "space-before-blocks": "error",

        "space-before-function-paren": ["error", {
            anonymous: "never",
            named: "never",
            asyncArrow: "always",
        }],

        "space-in-parens": "error",
        "space-infix-ops": "error",
        "spaced-comment": "error",
        yoda: "error",
    },
}];