import { createServer, type Server } from 'node:http';
import type { Engine } from './engine.js';
import { log } from './log.js';
import type { Store } from './store.js';
import type { Watcher } from './watcher.js';

/**
 * Replit only keeps a repl awake while something is listening, and an uptime
 * pinger needs a URL to hit, so the bot exposes its own status endpoint.
 */
export function startHealthServer(
  port: number,
  deps: { watcher: Watcher; engine: Engine; store: Store },
): Server {
  const server = createServer((request, response) => {
    const body = {
      ok: Date.now() - deps.watcher.lastBlockAt < 30_000,
      head: deps.watcher.head.toString(),
      lastBlockAgoMs: deps.watcher.lastBlockAt ? Date.now() - deps.watcher.lastBlockAt : null,
      blocksSeen: deps.watcher.blocksSeen,
      lastPollMs: Math.round(deps.watcher.lastPollMs),
      targets: deps.store.targets.length,
      paused: deps.store.settings.paused,
      dryRun: deps.store.settings.dryRun,
      stats: deps.engine.stats,
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body, null, 2));
    request.resume();
  });
  server.listen(port, () => log.info(`health endpoint on :${port}`));
  return server;
}
