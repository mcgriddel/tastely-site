import { escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
import { sbFetch, sbFetchOne, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type BoardVisibility = 'private' | 'friends' | 'link' | 'public';

type BoardSort = 'custom' | 'date' | 'alpha';

type Board = {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  visibility: BoardVisibility;
  share_token: string | null;
  cover_url: string | null;
  // The owner's persisted item order (set in-app). Travels with the board so
  // the shared page mirrors how the owner arranged it. Null/absent → custom.
  display_prefs: { sort?: BoardSort | null } | null;
};

type Profile = { username: string | null; display_name: string | null };

type BoardItemRow = {
  item_id: string;
  added_at: string | null;
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

// Item types whose cover art is square (1:1) — album + podcast art, mirroring
// the in-app `SQUARE_ART_TYPES`. Everything else (movie, book, tv) is a 2:3
// poster. The shape itself signals the medium on the grid.
const SQUARE_TYPES = new Set(['album', 'podcast_series']);

function tmdbAtSize(raw: string, size: string): string {
  if (raw.startsWith('http')) return raw.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`);
  return `${TMDB_IMAGE_BASE}/${size}${raw}`;
}

// Grid-scale cover for any vertical. TMDB posters (movie/tv) resized to w342;
// album/podcast art + book covers used as-is (https-forced); ISBN fallback.
function gridCoverForItem(it: BoardItemRow['items']): string {
  if (!it) return '';
  if (it.image_url) {
    if (it.image_url.includes('image.tmdb.org')) return tmdbAtSize(it.image_url, 'w342');
    return it.image_url.replace(/^http:/, 'https:');
  }
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
    path: `boards?id=eq.${encodeURIComponent(boardId)}&select=id,name,description,user_id,visibility,share_token,cover_url,display_prefs&limit=1`,
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
      path: `board_items?board_id=eq.${encodeURIComponent(boardId)}&select=added_at,item_id,items(title,image_url,external_id,item_type,metadata)&order=position.asc&limit=20`,
      key: 'service',
    }),
    sbFetchOne<Profile>(env, {
      path: `profiles?id=eq.${encodeURIComponent(board.user_id)}&select=username,display_name&limit=1`,
      key: 'service',
    }),
  ]);

  // Mirror the board's persisted sort (set in-app, display_prefs.sort) so the
  // recipient sees the same order. Rows are fetched in position order, which IS
  // the 'custom' order; re-sort for the other two. Comparators match the app
  // (alpha: title A→Z; date: most recently added first).
  const sort: BoardSort = board.display_prefs?.sort ?? 'custom';
  const sortedRows = [...(boardItems ?? [])];
  if (sort === 'alpha') {
    sortedRows.sort((a, b) => (a.items?.title ?? '').localeCompare(b.items?.title ?? ''));
  } else if (sort === 'date') {
    sortedRows.sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''));
  }

  const items = sortedRows.map((bi) => bi.items).filter((x): x is NonNullable<typeof x> => !!x);
  const count = items.length;
  const creator = profile?.display_name || profile?.username || 'someone';

  const ogTitle = board.name;
  const ogDescription = `${count} ${count === 1 ? 'item' : 'items'} curated by ${creator}`;
  const ogImage = board.cover_url || bigCoverForItem(items[0] ?? null);

  const gridHtml = items
    .map((it) => {
      const cover = gridCoverForItem(it);
      const isSquare = SQUARE_TYPES.has(it.item_type);
      const title = escapeHtml(it.title);
      const cls = `cover-tile${isSquare ? ' cover-tile--square' : ''}`;
      if (!cover) {
        return `
        <div class="${cls}">
          <div class="cover-img cover-img--placeholder"><span>${title}</span></div>
        </div>`;
      }
      return `
        <div class="${cls}">
          <img src="${cover}" alt="${title}" class="cover-img" loading="lazy" />
          <div class="cover-scrim" aria-hidden="true"></div>
          <div class="cover-caption"><div class="cover-caption-title">${title}</div></div>
        </div>`;
    })
    .join('');

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    showStickyBar: true,
    wide: true,
    body: `
      <div class="board-hero">
        <h1 class="board-title">${escapeHtml(board.name)}</h1>
        <p class="board-byline">by ${escapeHtml(creator)}</p>
        ${board.description ? `<p class="board-desc">${escapeHtml(board.description)}</p>` : ''}
      </div>
      ${gridHtml ? `<div class="board-grid">${gridHtml}</div>` : '<p class="empty">This board is empty</p>'}
    `,
  });

  return htmlResponse(html, 3600);
};
