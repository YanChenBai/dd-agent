import { defineConfig } from 'vite-plus';

const nativeBuildInput = [
  './src/**/*.rs',
  './build.rs',
  './Cargo.toml',
  './Cargo.lock',
  './package.json',
  './tsconfig.json',
  './vite.config.ts',
  './rustfmt.toml',
  './.cargo/**',
];

const nativeBuildIgnoredInput = [
  '!./target/**',
  '!./node_modules/**',
  '!./index.js',
  '!./index.d.ts',
  '!./*.node',
];

const nativeBuildOutput = ['./index.js', './index.d.ts', './*.node'];

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'napi build --platform --release --esm',
        input: [...nativeBuildInput, ...nativeBuildIgnoredInput],
        output: nativeBuildOutput,
      },
      'build:debug': {
        command: 'napi build --platform --esm',
        input: [...nativeBuildInput, ...nativeBuildIgnoredInput],
        output: nativeBuildOutput,
      },
      format: 'cargo fmt',
    },
  },
});
