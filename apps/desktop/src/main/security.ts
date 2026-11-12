/**
 * Which pages may talk to the main process, and which links may leave the app.
 * Everything else is refused (Workspace & Safety 06, App 07).
 */

interface RendererLocation {
  /** Folder holding the built renderer (out/renderer). */
  rendererDir: string;
  /** Dev server URL; set only while developing. */
  devServerUrl?: string | undefined;
}

const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const isWindowsPath = (p: string): boolean => /^[A-Za-z]:\//.test(p);

export function isTrustedRendererUrl(url: string | undefined, loc: RendererLocation): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (loc.devServerUrl && parsed.origin === new URL(loc.devServerUrl).origin) return true;
  if (parsed.protocol !== 'file:') return false;

  let file = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
  const dir = toPosix(loc.rendererDir);
  const [f, d] = isWindowsPath(dir) ? [file.toLowerCase(), dir.toLowerCase()] : [file, dir];
  return f === d || f.startsWith(`${d}/`);
}

/** Only https links may open in the user's browser. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
