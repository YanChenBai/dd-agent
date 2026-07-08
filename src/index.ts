import { resolve } from 'node:path';
import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';

import { startAgent } from './agent/index.ts';
import { env } from './env.ts';

export { startAgent };
export type { Agent, AgentOptions } from './agent/index.ts';

if (isDirectEntry()) {
  const agent = await startAgent(env.LIVE_ROOM_ID);
  nodeProcess.once('SIGINT', () => {
    void agent.stop();
  });
}

function isDirectEntry() {
  const entry = nodeProcess.argv[1];
  return entry ? fileURLToPath(import.meta.url) === resolve(entry) : false;
}
