import { createHash, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake update feed for e2e (Phase 3 C4): what electron-updater's generic provider reads, served on 127.0.0.1.
 *
 * - `GET /latest.yml` (Windows), `/latest-mac.yml` (macOS), `/latest-linux.yml` (Linux x64; `-<arch>` otherwise),
 *   with a `?noCache=…` query: YAML with `version`, `files: [{ url, sha512, size }]`, `path`, `sha512`, `releaseDate`
 *   and `releaseNotes`, the format electron-builder writes. Any `latest*.yml` gets the same answer.
 * - `GET /<installer>`: a few KB of random bytes. `sha512` is base64 of their SHA-512 (electron-updater's default
 *   encoding; it only reads hex when the value is 128 hex characters). Sent in slow chunks so "downloading" is seen.
 * - Anything else (e.g. the `.blockmap` files the differential download asks for first) is a 404; the updater then
 *   falls back to a full download.
 */
export interface FakeRelease {
  version: string;
  notes?: string;
}

export interface UpdateFeed {
  /** The generic-provider base URL (ends in "/"). */
  url: string;
  /** What the next requests get: a release, or a broken feed (that HTTP status for the yml). */
  serve(next: FakeRelease | { failWith: number }): void;
  /** Every request path so far (query left out). */
  readonly paths: string[];
  /** Requests for a `latest*.yml` so far. */
  ymlRequests(): number;
  /** Requests for the installer so far. */
  installerRequests(): number;
  close(): Promise<void>;
}

const YML = /^\/latest[\w-]*\.yml$/;
const INSTALLER_BYTES = 48 * 1024;
const CHUNKS = 12;
const CHUNK_DELAY_MS = 100;

/** The channel file electron-updater asks for on this machine (Provider.getChannelFilePrefix). */
export function channelFile(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'linux') return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
  return 'latest.yml';
}

/** The installer's name for this platform, the extension each updater looks for (exe / zip / AppImage). */
export function installerName(version: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return `The-Insectoids-${version}-mac.zip`;
  if (platform === 'linux') return `The-Insectoids-${version}.AppImage`;
  return `The-Insectoids-Setup-${version}.exe`;
}

const yamlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function latestYml(r: FakeRelease, sha512: string, size: number): string {
  const file = installerName(r.version);
  return [
    `version: ${yamlString(r.version)}`,
    'files:',
    `  - url: ${file}`,
    `    sha512: ${yamlString(sha512)}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${yamlString(sha512)}`,
    `releaseDate: ${yamlString(new Date().toISOString())}`,
    ...(r.notes ? [`releaseNotes: ${yamlString(r.notes)}`] : []),
    '',
  ].join('\n');
}

export async function startUpdateFeed(initial: FakeRelease | { failWith: number }): Promise<UpdateFeed> {
  // Fresh bytes each run, so a copy the updater cached from an earlier run never matches.
  const installer = randomBytes(INSTALLER_BYTES);
  const sha512 = createHash('sha512').update(installer).digest('base64');
  let current = initial;
  const paths: string[] = [];

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    paths.push(path);
    if (YML.test(path)) {
      if ('failWith' in current) {
        res.writeHead(current.failWith, { 'content-type': 'text/plain' });
        res.end('The feed is broken on purpose (e2e).');
        return;
      }
      const body = latestYml(current, sha512, installer.length);
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (!('failWith' in current) && path === `/${installerName(current.version)}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': installer.length });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const size = Math.ceil(installer.length / CHUNKS);
      let i = 0;
      const tick = (): void => {
        if (res.destroyed) return;
        res.write(installer.subarray(i * size, (i + 1) * size));
        i += 1;
        if (i < CHUNKS) setTimeout(tick, CHUNK_DELAY_MS);
        else res.end();
      };
      tick();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    serve: (next) => {
      current = next;
    },
    paths,
    ymlRequests: () => paths.filter((p) => YML.test(p)).length,
    installerRequests: () => paths.filter((p) => /\.(exe|zip|AppImage)$/.test(p)).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A base URL on a port nothing listens on (it was free a moment ago): connections are refused. */
export async function closedFeedUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}
