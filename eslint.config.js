// Lint for the web app and its packages. Its main job is the module boundaries of design §4.1 (quality-gates AC-16):
// a feature is used only through its index.ts, and packages/ui never imports app code. CI runs it as the "boundaries" step.
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/convoz/**", "e2e/**", "specs/**", "packages/api-client/src/schema.ts"] },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "packages/*/.ladle/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { boundaries, "react-hooks": reactHooks },
    settings: {
      "boundaries/include": ["apps/web/src/**/*", "packages/*/src/**/*"],
      "boundaries/elements": [
        { type: "feature", pattern: "apps/web/src/features/*", capture: ["name"] },
        { type: "app", pattern: "apps/web/src/*", capture: ["part"] },
        { type: "ui", pattern: "packages/ui/src" },
        { type: "package", pattern: "packages/*/src", capture: ["name"] },
      ],
    },
    rules: {
      // The last matching policy wins. Imports inside one element (a feature's own files) are not checked.
      "boundaries/dependencies": [
        2,
        {
          default: "allow",
          policies: [
            // Another feature is reached only through its index.ts (its public surface); everything else in it is private.
            { disallow: { to: { element: { type: "feature" } } }, message: "Import another feature only through its index.ts." },
            { allow: { to: { element: { type: "feature", fileInternalPath: "index.ts" } } } },
            // The component library knows nothing of the app: no app, feature or other package code.
            { from: { element: { type: "ui" } }, disallow: { to: { element: { type: "{app,feature,package}" } } }, message: "packages/ui must not import app code." },
          ],
        },
      ],
      "react-hooks/rules-of-hooks": 2,
      // Radix is wrapped once in packages/ui, so the app keeps one look and one accessibility behaviour per primitive.
      "no-restricted-imports": [2, { patterns: [{ group: ["@radix-ui/*"], message: "Use the wrapped primitive from @convoz/ui." }] }],
    },
  },
  { files: ["packages/ui/src/**/*.{ts,tsx}"], rules: { "no-restricted-imports": 0 } },
];
