import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('provider boundaries', () => {
  it('starts without Max or Overloop credentials', () => {
    const config = parseConfig({});
    expect(config.MAX_API_KEY).toBeUndefined();
    expect(config.OVERLOOP_API_KEY).toBeUndefined();
    expect(config.SEND_MODE).toBe('locked');
  });

  it('keeps provider clients out of the core pipeline', () => {
    const pipelineDir = path.join(ROOT, 'src', 'pipeline');
    const violations = fs
      .readdirSync(pipelineDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /clients\/(max|overloop)/.test(fs.readFileSync(path.join(pipelineDir, name), 'utf8')));
    expect(violations).toEqual([]);
  });
});
