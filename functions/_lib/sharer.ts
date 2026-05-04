// Sharer-attribution lookup — when a share URL includes ?from={userId},
// resolve the sharer's display_name + avatar so the landing page can render
// "Mac sent you this" above the hero. Untapped differentiator across the
// surveyed competitive set; central to Tastely's interpersonal-recommendation
// thesis. Plan §2.6.
//
// Falls back gracefully:
//   - missing ?from              → no row rendered
//   - profile lookup fails       → no row rendered
//   - profile is private/deleted → no row rendered
//   - display_name unset         → fall back to @username
//
// We use the anon key here because all profiles are visible to anyone with
// the user_id (this is by RLS design — `profiles` row is public for share-
// attribution + public-profile pages).

import { sbFetchOne, type SupabaseEnv } from './supabase';

export type SharerProfile = {
  id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
};

export async function lookupSharer(
  env: SupabaseEnv,
  fromUserId: string | null,
): Promise<SharerProfile | null> {
  if (!fromUserId) return null;
  // UUID v4 sanity check — bail before hitting the DB on garbage input.
  if (!/^[0-9a-f-]{32,40}$/i.test(fromUserId)) return null;

  const profile = await sbFetchOne<SharerProfile>(env, {
    path: `profiles?id=eq.${encodeURIComponent(fromUserId)}&select=id,display_name,username,avatar_url&limit=1`,
    key: 'anon',
  });
  if (!profile) return null;

  // Need at least one of display_name or username to render anything.
  if (!profile.display_name && !profile.username) return null;
  return profile;
}

export function sharerDisplayName(p: SharerProfile): string {
  return p.display_name || `@${p.username}` || 'A friend';
}
