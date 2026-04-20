import { escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
import { sbFetch, sbFetchOne, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  friend_count: number | null;
  is_private: boolean | null;
};

type UserItemRow = {
  item_id: string;
  items: {
    title: string;
    image_url: string | null;
    item_type: string;
    metadata: { isbn?: string } | null;
  } | null;
};

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function coverSmall(it: UserItemRow['items']): string {
  if (!it) return '';
  if (it.item_type === 'movie' && it.image_url) return `${TMDB_IMAGE_BASE}/w342${it.image_url}`;
  if (it.image_url) return it.image_url.replace(/^http:/, 'https:');
  if (it.metadata?.isbn) return `https://covers.openlibrary.org/b/isbn/${it.metadata.isbn.replace(/[^0-9Xx]/g, '')}-M.jpg`;
  return '';
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const userId = String(params.id);
  const ogUrl = new URL(request.url).toString();

  const profile = await sbFetchOne<Profile>(env, {
    path: `profiles?id=eq.${encodeURIComponent(userId)}&select=id,username,display_name,avatar_url,bio,friend_count,is_private&limit=1`,
    key: 'service',
  });

  if (!profile) return notFoundPage('Profile not found');
  if (profile.is_private) return notFoundPage('This profile is private');

  const saves = await sbFetch<UserItemRow>(env, {
    path: `user_items?user_id=eq.${encodeURIComponent(userId)}&select=item_id,items(title,image_url,item_type,metadata)&order=added_at.desc&limit=12`,
    key: 'service',
  });

  const items = (saves ?? []).map((s) => s.items).filter((x): x is NonNullable<typeof x> => !!x);
  const display = profile.display_name || profile.username || 'Tastely user';
  const handle = profile.username ? `@${profile.username}` : '';

  const ogTitle = `${display} on Tastely`;
  const ogDescription = profile.bio
    ? profile.bio.slice(0, 150)
    : `${items.length} ${items.length === 1 ? 'save' : 'saves'}${profile.friend_count ? ` · ${profile.friend_count} friends` : ''}`;
  const ogImage = profile.avatar_url || coverSmall(items[0] ?? null);

  const gridHtml = items
    .map((it) => {
      const cover = coverSmall(it);
      return `<div class="grid-item">${cover ? `<img src="${cover}" alt="${escapeHtml(it.title)}" loading="lazy" />` : ''}</div>`;
    })
    .join('');

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    body: `
      <div class="profile-header">
        ${profile.avatar_url ? `<img src="${escapeHtml(profile.avatar_url)}" alt="${escapeHtml(display)}" class="avatar" />` : '<div class="avatar"></div>'}
        <div class="profile-info">
          <h1>${escapeHtml(display)}</h1>
          ${handle ? `<p class="profile-handle">${escapeHtml(handle)}</p>` : ''}
        </div>
      </div>
      ${profile.bio ? `<p class="profile-bio">${escapeHtml(profile.bio)}</p>` : ''}
      ${items.length > 0 ? `<div class="grid">${gridHtml}</div>` : '<p class="empty">No public saves yet</p>'}
      <div class="cta">
        <p class="cta-text">Follow ${escapeHtml(display)} on Tastely</p>
        <a href="https://trytastely.com" class="cta-button">Get Tastely</a>
      </div>
    `,
  });

  return htmlResponse(html, 3600);
};
