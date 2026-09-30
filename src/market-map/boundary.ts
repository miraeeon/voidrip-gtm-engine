import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

export const BOUNDARY_VERSION = 'GTM_BOUNDARY_V1' as const;
export const BOUNDARY_FILE = path.join(ROOT, 'data', 'boundary.md');

export function getBoundaryContract() {
  return { version: BOUNDARY_VERSION, content: fs.readFileSync(BOUNDARY_FILE, 'utf8') };
}
