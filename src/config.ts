import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = process.env.GTM_ENV_FILE ? path.resolve(process.env.GTM_ENV_FILE) : path.join(ROOT, '.env');

loadDotenv({ path: ENV_FILE, quiet: true });

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24h)');
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const dayList = z
  .string()
  .transform((s) => s.split(',').map((d) => d.trim().toUpperCase().slice(0, 3)).filter(Boolean))
  .pipe(z.array(z.enum(DAYS)).min(1));
const EnvSchema = z.object({
  // --- platform credentials ---
  MAX_API_KEY: z
    .string()
    .min(10, 'MAX_API_KEY looks too short — check the value in .env')
    .optional(),
  OVERLOOP_API_KEY: z
    .string()
    .min(10, 'OVERLOOP_API_KEY looks too short — check the value in .env')
    .optional(),
  HEYREACH_API_KEY: z
    .string()
    .min(10, 'HEYREACH_API_KEY looks too short — check the value in .env')
    .optional(),
  MAX_BUSINESS_ID: z.coerce.number().int().min(0).default(0).describe('0 = not chosen yet (run npm run setup)'),
  MAX_API_URL: z.string().url().default('https://api.yourmax.ai/api/v1'),
  OVERLOOP_API_URL: z.string().url().default('https://api.overloop.ai/public/v2'),
  HEYREACH_API_URL: z.string().url().default('https://api.heyreach.io/api/public'),
  HEYREACH_CAMPAIGN_ID: z.coerce.number().int().min(0).default(0).describe('existing HeyReach campaign; 0 = not configured'),
  HEYREACH_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(60),

  // --- safety ---
  SEND_MODE: z.enum(['locked', 'live']).default('locked'),
  OVERLOOP_NAME_PREFIX: z.string().default('[GTM-BOT]'),

  // --- Overloop campaign settings (applied to every campaign the bot creates) ---
  OVERLOOP_TIMEZONE: z.string().default('Europe/Brussels'),
  OVERLOOP_SENDER_ID: z.string().optional(),
  OVERLOOP_SENDING_DAYS: dayList.default(['MON', 'TUE', 'WED', 'THU', 'FRI']),
  OVERLOOP_SEND_START: hhmm.default('09:00'),
  OVERLOOP_SEND_END: hhmm.default('17:00'),

  // --- daily volume caps ---
  GTM_DAILY_NEW_LEADS: z.coerce.number().int().min(0).default(20).describe('target qualified prospects reviewed per day'),
  GTM_DAILY_SEQUENCES: z.coerce.number().int().min(0).default(20).describe('max sequences finalized per day'),
  GTM_DAILY_PUSH_LIMIT: z.coerce.number().int().min(0).default(20).describe('max provider imports per day after explicit approval'),
  GTM_SOURCE_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(10),
  GTM_ENRICH_FROM_OVERLOOP: bool.default(true),

  // --- scheduler / daily runner ---
  GTM_SCHEDULE_ENABLED: bool.default(false),
  GTM_SCHEDULE_TIME: hhmm.default('08:00'),
  GTM_SCHEDULE_DAYS: dayList.default(['MON', 'TUE', 'WED', 'THU', 'FRI']),
  GTM_AGENT_CMD: z.string().default('codex').describe('Codex CLI command used by the daily runner'),
  GTM_MODEL: z.string().default('').describe('optional Codex model override; empty uses the configured default'),
  GTM_RUN_TIMEOUT_MIN: z.coerce.number().int().min(5).max(600).default(90),
  GTM_LOOP_NOTE: z.string().default('').describe('extra instructions appended to every daily run'),

  // --- storage & housekeeping ---
  GTM_DB_PATH: z.string().default(path.join(ROOT, 'data', 'gtm.db')),
  GTM_REPORTS_DIR: z.string().default(path.join(ROOT, 'reports')),
  GTM_BACKUP_DIR: z.string().default(path.join(ROOT, 'data', 'backups')),
  GTM_BACKUP_KEEP: z.coerce.number().int().min(0).default(14),
  GTM_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

export type Config = z.infer<typeof EnvSchema>;
export const WEEKDAYS = DAYS;

let cached: Config | undefined;

/** Pure: validate an env map. Empty values ("KEY=") mean "use the default". */
export function parseConfig(source: Record<string, string | undefined>): Config {
  const env = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration in ${ENV_FILE}:\n${msg}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Re-read .env (after the setup wizard writes it). */
export function reloadConfig(): Config {
  loadDotenv({ path: ENV_FILE, quiet: true, override: true });
  cached = undefined;
  return getConfig();
}

/** The configured Max business, with a helpful error when setup hasn't chosen one yet. */
export function businessId(): number {
  const id = getConfig().MAX_BUSINESS_ID;
  if (!id) throw new Error('MAX_BUSINESS_ID is not set — run `npm run setup` (or `gtm init --website <your site>`)');
  return id;
}

export const toMinutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Test helper: override config without touching process.env. */
export function setConfigForTests(partial: Partial<Config>): void {
  cached = {
    ...EnvSchema.parse({ MAX_API_KEY: 'test-max-key-000', OVERLOOP_API_KEY: 'test-ovl-key-000' }),
    MAX_API_URL: 'https://max.test/api/v1',
    OVERLOOP_API_URL: 'https://ovl.test/public/v2',
    GTM_DB_PATH: ':memory:',
    MAX_BUSINESS_ID: 143,
    ...partial,
  };
}
