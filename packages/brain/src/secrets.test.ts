import { describe, expect, it } from 'vitest';
import { detectSecrets } from './secrets';

describe('secrets guard (Memory 01-E6)', () => {
  it.each([
    ['Anthropic key', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['OpenAI-style key', 'OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234'],
    ['AWS access key', 'aws AKIAIOSFODNN7EXAMPLE here'],
    ['GitHub token', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['Slack token', 'xoxb-1234567890-0987654321-AbCdEfGhIjKl'],
    ['private key block', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'],
    ['password assignment', 'DB_PASSWORD=hunter2hunter2'],
    ['bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'],
  ])('flags %s', (_label, text) => {
    expect(detectSecrets(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['plain prose', 'The Queen planned three waves for the pricing page.'],
    ['talking about keys', 'Store the API key in the vault, never in code.'],
    ['a git hash', 'merged at 1fe0aa8 and ddd062a'],
    ['an env var name only', 'Set OPENAI_API_KEY in your shell.'],
  ])('does not flag %s', (_label, text) => {
    expect(detectSecrets(text)).toEqual([]);
  });

  it('reports what kind of secret it found, never the value', () => {
    const found = detectSecrets('token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(found).toEqual(['github-token']);
  });
});
