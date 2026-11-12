import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security';

describe('isTrustedRendererUrl', () => {
  const rendererDir = 'C:/app/out/renderer';

  it('trusts the packaged renderer page', () => {
    expect(isTrustedRendererUrl('file:///C:/app/out/renderer/index.html', { rendererDir })).toBe(true);
  });

  it('rejects other local files', () => {
    expect(isTrustedRendererUrl('file:///C:/Users/me/evil.html', { rendererDir })).toBe(false);
  });

  it('rejects a path that only starts with the renderer folder name', () => {
    expect(isTrustedRendererUrl('file:///C:/app/out/renderer-evil/index.html', { rendererDir })).toBe(false);
  });

  it('trusts the dev server origin only in development', () => {
    const devServerUrl = 'http://localhost:5173';
    expect(isTrustedRendererUrl('http://localhost:5173/', { rendererDir, devServerUrl })).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', { rendererDir, devServerUrl })).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', { rendererDir })).toBe(false);
  });

  it('rejects remote pages and garbage', () => {
    expect(isTrustedRendererUrl('https://example.com/', { rendererDir })).toBe(false);
    expect(isTrustedRendererUrl('not a url', { rendererDir })).toBe(false);
    expect(isTrustedRendererUrl(undefined, { rendererDir })).toBe(false);
  });
});

describe('isAllowedExternalUrl', () => {
  it('allows https links to open in the system browser', () => {
    expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true);
  });

  it('blocks every other scheme', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(false);
    expect(isAllowedExternalUrl('file:///C:/Windows/system32/calc.exe')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });
});
