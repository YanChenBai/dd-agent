import vue from '@vitejs/plugin-vue';
import { vueTui } from '@vue-tui/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig(({ mode }) => ({
  plugins: [vue(), ...(mode === 'test' ? [] : vueTui({ entry: 'src/index.ts' }))],
  build: {
    rolldownOptions: {
      output: {
        minify: false,
      },
    },
  },
  run: {
    tasks: {
      build: {
        command: 'vp build',
      },
      dev: {
        cache: false,
        command: 'vp dev',
      },
      start: {
        cache: false,
        command: 'node --env-file=.env dist/index.js',
        dependsOn: ['build'],
      },
    },
  },
}));
