import { openDb, setDbForTests } from '../src/db/db.js';
import { setConfigForTests, type Config } from '../src/config.js';

export function freshEnv(cfg: Partial<Config> = {}) {
  setConfigForTests(cfg);
  const db = openDb(':memory:');
  setDbForTests(db);
  return db;
}

export interface Call {
  method: string;
  url: string;
  body?: any;
}

/** Fake fetch: routes by "METHOD /path" prefix; records calls. */
export function fakeFetch(routes: Record<string, (body: any, url: string) => unknown>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const key = Object.keys(routes)
      .filter((k) => {
        const [m, p] = k.split(' ');
        // "…/" keys match any id below that path, e.g. "GET /prospects/" matches /prospects/500
        return m === method && (p!.endsWith('/') ? u.pathname.includes(p!) : u.pathname.endsWith(p!));
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ error: `no route ${method} ${u.pathname}` }), { status: 404 });
    return new Response(JSON.stringify(routes[key]!(body, url)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

export function maxLead(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    external_id: `ext-${id}`,
    name: `Jane Doe${id}`,
    headline: 'CMO at Acme',
    job_title: 'Chief Marketing Officer',
    email: `jane${id}@acme.com`,
    phone: null,
    linkedin_url: `https://www.linkedin.com/in/jane-${id}`,
    location: 'Brussels, Belgium',
    company: 'Acme',
    company_industry: 'Marketing',
    company_size: '51-200',
    company_website: 'https://acme.com',
    company_linkedin: null,
    icp_score: 3,
    engagement_type: 'comment',
    post_url: 'https://linkedin.com/posts/x',
    signals: [{ name: 'Social Mentions', slug: 'social-mentions' }],
    subscription_ids: [1],
    payload: { engagement_context: 'Commented on a post about agency selection', company_summary: 'Acme is a B2B marketing agency.' },
    triggered_at: '2026-09-27T10:00:00Z',
    created_at: '2026-09-27T10:00:00Z',
    ...over,
  };
}
