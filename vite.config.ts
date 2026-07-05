import vue from '@vitejs/plugin-vue';
import { vueTui } from '@vue-tui/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [vue(), vueTui({ entry: 'src/index.ts' })],
  build: {
    rolldownOptions: {
      output: {
        minify: false,
      },
    },
  },
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
  run: {
    cache: true,
    tasks: {
      build: {
        command: 'vp build',
      },
      dev: {
        cache: false,
        command: 'vp dev',
      },
      ready: {
        command: 'vp check && vp test && vp build',
      },
      start: {
        cache: false,
        command: 'node --import @oxc-node/core/register --env-file=.env dist/index.js',
        dependsOn: ['build'],
      },
    },
  },
});
