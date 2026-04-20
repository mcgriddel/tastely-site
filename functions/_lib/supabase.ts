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
