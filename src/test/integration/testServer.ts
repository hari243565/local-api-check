import * as http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A local HTTP server for the integration suite.
 *
 * Two instances listen on fixed ports that match the two fixture environments,
 * so switching environment demonstrably changes which server answers. Nothing
 * here leaves the machine — the suite stays as offline as the extension.
 */

/** Port used by .api-env/local.json. */
export const LOCAL_PORT = 39871;
/** Port used by .api-env/staging.json. */
export const STAGING_PORT = 39872;

const servers = new Map<number, http.Server>();

function handle(port: number): http.RequestListener {
  return (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '/';
      const path = url.split('?')[0];
      const method = (request.method ?? 'GET').toUpperCase();
      const body = Buffer.concat(chunks).toString('utf8');

      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(payload));
      };

      if (path === '/echo') {
        // `id` and `title` are here so the fixture's json_has passes; the rest
        // is what the tests assert the extension actually sent.
        json(200, {
          id: 1,
          title: 'echo',
          port,
          method,
          path,
          headers: request.headers,
          body
        });
        return;
      }

      if (path === '/todos/1' && method === 'GET') {
        json(200, { userId: 1, id: 1, title: 'fixture todo', completed: false });
        return;
      }

      if (path === '/posts' && method === 'POST') {
        json(201, { id: 101, received: body });
        return;
      }

      if (path === '/plain') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('this is not json');
        return;
      }

      json(404, {});
    });
  };
}

async function listen(port: number): Promise<void> {
  if (servers.has(port)) {
    return;
  }
  const server = http.createServer(handle(port));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || address.port !== port) {
    throw new Error(`test server bound to the wrong port: ${JSON.stringify(address)}`);
  }
  // Do not hold the test process open once the suite is finished.
  server.unref();
  servers.set(port, server);
}

/** Idempotent: safe to call from every suite's `before` hook. */
export async function ensureTestServers(): Promise<void> {
  await listen(LOCAL_PORT);
  await listen(STAGING_PORT);
}
