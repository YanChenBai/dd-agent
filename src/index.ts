#!/usr/bin/env node

import { command, cli } from 'cleye';

import { loadDDConfig } from './config/index.ts';

const singleCommand = command(
  {
    name: 'single',
    parameters: ['[room-id]'],
    flags: {
      sendDanmaku: { type: Boolean, description: 'Send generated danmaku.' },
      stopAfterMs: { type: Number, description: 'Stop after this many milliseconds.' },
    },
    help: { description: 'Watch one Bilibili live room.' },
  },
  async argv => {
    await withProcessSignals(async signal => {
      const config = await loadDDConfig();

      const { createDD } = await import('./dd/index.ts');
      const roomId = argv._.roomId ? Number(argv._.roomId) : config.live.roomId;
      const dd = await createDD(roomId, {
        sendDanmakuEnabled: argv.flags.sendDanmaku,
        stopAfterMs: argv.flags.stopAfterMs,
        signal,
      });

      await dd.waitForStop();
    });
  },
);

const exploreCommand = command(
  {
    name: 'explore',
    flags: {
      areaUrl: { type: String, description: 'Bilibili live area URL.' },
      maxRunMs: { type: Number, description: 'Maximum total runtime in milliseconds.' },
      observeRoomMs: { type: Number, description: 'Maximum observation time per room.' },
      candidateLimit: { type: Number, description: 'Maximum candidates per refresh.' },
      sendDanmaku: { type: Boolean, description: 'Send generated danmaku.' },
    },
    help: { description: 'Run the DD live-room exploration agent.' },
  },
  async argv => {
    await withProcessSignals(async signal => {
      const { startExplore } = await import('./dd/explore/index.ts');
      await startExplore({
        areaUrl: argv.flags.areaUrl,
        maxRunMs: argv.flags.maxRunMs,
        observeRoomMs: argv.flags.observeRoomMs,
        candidateLimit: argv.flags.candidateLimit,
        sendDanmakuEnabled: argv.flags.sendDanmaku,
        signal,
      });
    });
  },
);

await cli({
  name: 'dd',
  version: '0.0.0',
  commands: [singleCommand, exploreCommand],
  help: {
    description: 'A multimodal danmaku agent for Bilibili live streams.',
    usage: ['dd single [room-id]', 'dd explore'],
  },
  strictFlags: true,
});

async function withProcessSignals(run: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    controller.abort(new Error(`Received ${signal}`));
  };
  const handleSigint = () => abort('SIGINT');
  const handleSigterm = () => abort('SIGTERM');
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  try {
    await run(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
  }
}
