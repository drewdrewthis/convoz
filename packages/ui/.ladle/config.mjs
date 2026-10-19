// Ladle: the story book of packages/ui. Playwright runs axe and screenshots over these stories (quality-gates AC-17).
export default {
  stories: "src/**/*.stories.tsx",
  outDir: "ladle-build",
  viteConfig: ".ladle/vite.config.ts",
};
