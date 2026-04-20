// Diagnostic endpoint — reports which env vars are bound (boolean only).
// Safe: never echoes values. Remove after verification.
export const onRequestGet: PagesFunction = async ({ env }) => {
  const e = env as Record<string, unknown>;
  const report = {
    SUPABASE_URL: !!e.SUPABASE_URL,
    SUPABASE_URL_prefix: typeof e.SUPABASE_URL === 'string' ? (e.SUPABASE_URL as string).slice(0, 30) : null,
    SUPABASE_SERVICE_ROLE_KEY: !!e.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY_len:
      typeof e.SUPABASE_SERVICE_ROLE_KEY === 'string' ? (e.SUPABASE_SERVICE_ROLE_KEY as string).length : 0,
    TMDB_API_KEY: !!e.TMDB_API_KEY,
    TMDB_API_KEY_len: typeof e.TMDB_API_KEY === 'string' ? (e.TMDB_API_KEY as string).length : 0,
  };
  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};
