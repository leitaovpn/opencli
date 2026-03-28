import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('extension manifest', () => {
  it('grants host permissions required for cookie-backed browser commands', () => {
    const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions?: string[] };

    expect(manifest.host_permissions).toContain('<all_urls>');
  });
});
