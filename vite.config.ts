import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    singleQuote: true,
    sortImports: true,
    sortTailwindcss: true,
    sortPackageJson: true,
    arrowParens: 'avoid',
    embeddedLanguageFormatting: 'auto',
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  resolve: {
    tsconfigPaths: true,
  },
  pack: {
    entry: 'src/index.ts',
    format: ['esm'],
    dts: false,
    outDir: 'dist',
    sourcemap: true,
  },
  run: {
    cache: true,
    tasks: {
      build: {
        command: 'vp pack',
      },
      dev: {
        cache: false,
        command: 'node --import @oxc-node/core/register --watch src/index.ts',
      },
      ready: {
        command: 'vp check && vp test && vp pack',
      },
      start: {
        cache: false,
        command: 'node --import @oxc-node/core/register dist/index.mjs',
        dependsOn: ['build'],
      },
    },
  },
});
