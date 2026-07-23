import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createMemory } from './index.ts';

describe('createMemory', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes stale vision files left by an earlier process', () => {
    const directory = createTempDirectory();
    const staleFile = join(directory, 'stale.jpg');
    const freshFile = join(directory, 'fresh.jpg');
    writeFileSync(staleFile, 'stale');
    writeFileSync(freshFile, 'fresh');
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(staleFile, oldTime, oldTime);

    createMemory(30_000, directory);

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  it('removes files owned by the current memory when cleared', () => {
    const directory = createTempDirectory();
    const memory = createMemory(30_000, directory);
    memory.addVision({
      buffer: Buffer.from('image'),
      frames: [],
      startTimeMs: 100,
      endTimeMs: 200,
      mediaStartMs: 0,
      mediaEndMs: 100,
    });
    const [record] = memory.query({ startTimeMs: 0, endTimeMs: 300 });

    expect(record?.type).toBe('vision');
    if (record?.type !== 'vision') {
      throw new Error('Expected a vision record');
    }
    expect(existsSync(record.filePath)).toBe(true);

    memory.clear();

    expect(memory.getSize()).toBe(0);
    expect(existsSync(record.filePath)).toBe(false);
  });

  function createTempDirectory() {
    const directory = mkdtempSync(join(tmpdir(), 'dd-memory-test-'));
    directories.push(directory);
    return directory;
  }
});
