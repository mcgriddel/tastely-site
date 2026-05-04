// Thin Supabase REST wrapper — avoids @supabase/supabase-js in Workers runtime
// (smaller bundle, no Deno/Node shims needed).

export type SupabaseEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
};

type FetchOpts = {
  path: string;                // e.g. "items?external_id=eq.123&item_type=eq.movie&select=*"
  key: 'service' | 'anon';
};

export async function sbFetch<T = unknown>(env: SupabaseEnv, opts: FetchOpts): Promise<T[] | null> {
  const apikey = opts.key === 'service' ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  if (!apikey || !env.SUPABASE_URL) return null;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${opts.path}`, {
    headers: {
      apikey,
      Authorization: `Bearer ${apikey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) return null;
  return res.json() as Promise<T[]>;
}

export async function sbFetchOne<T = unknown>(env: SupabaseEnv, opts: FetchOpts): Promise<T | null> {
  const rows = await sbFetch<T>(env, opts);
  return rows && rows.length > 0 ? rows[0] : null;
}

type InsertOpts = {
  table: string;            // 'share_intents'
  body: Record<string, unknown> | Record<string, unknown>[];
  returning?: 'minimal' | 'representation';
};

export async function sbInsert(env: SupabaseEnv, opts: InsertOpts): Promise<{ ok: boolean; data?: unknown }> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) return { ok: false };
  const apikey = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${opts.table}`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${apikey}`,
      'Content-Type': 'application/json',
      Prefer: `return=${opts.returning ?? 'minimal'}`,
    },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) return { ok: false };
  if (opts.returning === 'representation') {
    return { ok: true, data: await res.json() };
  }
  return { ok: true };
}

export async function sbRpc<T = unknown>(env: SupabaseEnv, fn: string, args: Record<string, unknown>): Promise<T | null> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) return null;
  const apikey = env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey,
      Authorization: `Bearer ${apikey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}
