import { escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
import { sbFetch, sbFetchOne, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type BoardVisibility = 'private' | 'friends' | 'link' | 'public';

type Board = {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  visibility: BoardVisibility;
  share_token: string | null;
  cover_url: string | null;
};

type Profile = { username: string | null; display_name: string | null };

type BoardItemRow = {
  item_id: string;
  items: {
    title: string;
    image_url: string | null;
    external_id: string;
    item_type: string;
    metadata: {
      releaseDate?: string;
      voteAverage?: number;
      authors?: string[];
      isbn?: string;
      publishedDate?: string;
    } | null;
  } | null;
};

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function tmdbAtSize(raw: string, size: string): string {
  if (raw.startsWith('http')) return raw.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`);
  return `${TMDB_IMAGE_BASE}/${size}${raw}`;
}

function coverForItem(it: BoardItemRow['items']): string {
  if (!it) return '';
  if (it.item_type === 'movie' && it.image_url) return tmdbAtSize(it.image_url, 'w154');
  if (it.item_type === 'movie' && !it.image_url) return '';
  if (it.image_url) return it.image_url.replace(/^http:/, 'https:');
  if (it.metadata?.isbn) return `https://covers.openlibrary.org/b/isbn/${it.metadata.isbn.replace(/[^0-9Xx]/g, '')}-M.jpg`;
  return '';
}

function bigCoverForItem(it: BoardItemRow['items']): string {
  if (!it) return '';
  if (it.item_type === 'movie' && it.image_url) return tmdbAtSize(it.image_url, 'w500');
  if (it.image_url) return it.image_url.replace(/^http:/, 'https:');
  if (it.metadata?.isbn) return `https://covers.openlibrary.org/b/isbn/${it.metadata.isbn.replace(/[^0-9Xx]/g, '')}-L.jpg`;
  return '';
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const boardId = String(params.id);
  const reqUrl = new URL(request.url);
  const ogUrl = reqUrl.toString();
  const shareToken = reqUrl.searchParams.get('t');

  const board = await sbFetchOne<Board>(env, {
    path: `boards?id=eq.${encodeURIComponent(boardId)}&select=id,name,description,user_id,visibility,share_token,cover_url&limit=1`,
    key: 'service',
  });

  if (!board) return notFoundPage('Board not found');

  // Mirror the visibility model (mig 040). The page is publicly served, so only
  // `public` boards — and `link` boards opened with their matching share token
  // (`?t=`) — resolve on the web. `friends` boards need the in-app friendship
  // check; `private` boards are never shareable. Matches the
  // `get_board_by_share_token` RPC gate (visibility IN ('link','public')).
  const isPublic = board.visibility === 'public';
  const isValidLink =
    board.visibility === 'link' &&
    !!board.share_token &&
    !!shareToken &&
    board.share_token === shareToken;

  if (!isPublic && !isValidLink) {
    return notFoundPage('This board is private');
  }

  const [boardItems, profile] = await Promise.all([
    sbFetch<BoardItemRow>(env, {
      path: `board_items?board_id=eq.${encodeURIComponent(boardId)}&select=item_id,items(title,image_url,external_id,item_type,metadata)&order=position.asc&limit=20`,
      key: 'service',
    }),
    sbFetchOne<Profile>(env, {
      path: `profiles?id=eq.${encodeURIComponent(board.user_id)}&select=username,display_name&limit=1`,
      key: 'service',
    }),
  ]);

  const items = (boardItems ?? []).map((bi) => bi.items).filter((x): x is NonNullable<typeof x> => !!x);
  const count = items.length;
  const creator = profile?.display_name || profile?.username || 'someone';

  const ogTitle = board.name;
  const ogDescription = `${count} ${count === 1 ? 'item' : 'items'} curated by ${creator}`;
  const ogImage = board.cover_url || bigCoverForItem(items[0] ?? null);

  const itemListHtml = items
    .map((it) => {
      const cover = coverForItem(it);
      const sub =
        it.item_type === 'movie'
          ? [it.metadata?.releaseDate?.slice(0, 4), it.metadata?.voteAverage ? `★ ${it.metadata.voteAverage.toFixed(1)}` : '']
              .filter(Boolean)
              .join(' · ')
          : (it.metadata?.authors?.[0] ?? '');
      return `
        <div class="item-card">
          ${cover ? `<img src="${cover}" alt="${escapeHtml(it.title)}" class="poster" loading="lazy" />` : '<div class="poster-placeholder"></div>'}
          <div class="item-info">
            <div class="item-title">${escapeHtml(it.title)}</div>
            ${sub ? `<div class="item-meta">${escapeHtml(sub)}</div>` : ''}
          </div>
        </div>`;
    })
    .join('');

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    body: `
      <div class="header">
        <div class="tag-label">BOARD</div>
        <h1>${escapeHtml(board.name)}</h1>
        <p class="subtitle">by ${escapeHtml(creator)} · ${count} ${count === 1 ? 'item' : 'items'}</p>
        ${board.description ? `<p class="description">${escapeHtml(board.description)}</p>` : ''}
      </div>
      <div class="item-list">
        ${itemListHtml || '<p class="empty">This board is empty</p>'}
      </div>
      <div class="cta">
        <p class="cta-text">Discover more on Tastely</p>
        <a href="https://trytastely.com" class="cta-button">Get Tastely</a>
      </div>
    `,
  });

  return htmlResponse(html, 3600);
};
