// Lint for the web app and its packages. Its main job is the module boundaries of design §4.1 (quality-gates AC-16):
// a feature is used only through its index.ts, and packages/ui never imports app code. CI runs it as the "boundaries" step.
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// The ratchet rules (design: component library). Each has its own rule id, so the counted suppressions in eslint-suppressions.json
// are per rule and a fix of one kind cannot hide a new offence of another. The file may only shrink (scripts/check_suppressions.py).
const ban = (selector, message) => ({ meta: { schema: [] }, create: (context) => ({ [selector]: (node) => context.report({ node, message }) }) });
const convoz = {
  rules: {
    "no-raw-button": ban("JSXOpeningElement[name.name='button']", "Use Button from @convoz/ui, not a raw <button>."),
    "no-raw-input": ban("JSXOpeningElement[name.name='input']", "Use Field from @convoz/ui, not a raw <input>."),
    "no-style-prop": ban("JSXAttribute[name.name='style']", "No style prop: use Tailwind classes. A value only known at run time may keep it, with a disable comment that says why."),
  },
};
const radixImports = { group: ["@radix-ui/*"], message: "Use the wrapped primitive from @convoz/ui." };

export default [
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  { ignores: ["**/node_modules/**", "**/dist/**", "apps/convoz/**", "e2e/**", "specs/**", "packages/api-client/src/schema.ts"] },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "packages/*/.ladle/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { boundaries, convoz, "react-hooks": reactHooks },
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
      "react-hooks/exhaustive-deps": 2,
      // Radix is wrapped once in packages/ui, so the app keeps one look and one accessibility behaviour per primitive.
      "no-restricted-imports": [2, { patterns: [radixImports] }],
      "convoz/no-raw-button": 2,
      "convoz/no-raw-input": 2,
      "convoz/no-style-prop": 2,
      "max-lines": [2, { max: 300, skipComments: true, skipBlankLines: true }],
    },
  },
  // A feature owns no stylesheet: its look is the atoms of packages/ui and Tailwind classes.
  {
    files: ["apps/web/src/features/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": [2, { patterns: [radixImports, { group: ["**/*.css"], message: "A feature has no .css file: use the atoms of @convoz/ui and Tailwind classes." }] }] },
  },
  // The atoms are where the native elements live.
  { files: ["packages/ui/src/**/*.{ts,tsx}"], rules: { "no-restricted-imports": 0, "convoz/no-raw-button": 0, "convoz/no-raw-input": 0 } },
];
