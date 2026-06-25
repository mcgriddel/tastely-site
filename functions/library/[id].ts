import { escapeAttr, escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
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
    release_date: string | null;
    metadata: {
      releaseDate?: string;
      release_date?: string;
      first_air_date?: string;
      voteAverage?: number;
      authors?: string[];
      isbn?: string;
      publishedDate?: string;
      artist_name?: string;
      author?: string;
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

// Subtle second caption line for a board tile: the most identifying secondary
// fact per medium — author (books), artist (albums/podcasts), else release year.
// Gives a recipient context on each tile without a tap; falls back to year, then
// nothing. Mirrors how Letterboxd captions a year and Goodreads an author.
function gridSubtitleForItem(it: NonNullable<BoardItemRow['items']>): string {
  const m = it.metadata ?? {};
  // Canonical release_date column first — movies/TV store the date there, not in
  // metadata.releaseDate (camelCase, which is never populated). Then metadata
  // fallbacks for books (publishedDate) and any legacy shapes.
  const year = (
    it.release_date || m.release_date || m.first_air_date || m.releaseDate || m.publishedDate || ''
  ).slice(0, 4);
  if (it.item_type === 'book') return m.authors?.[0] || year;
  if (it.item_type === 'album') return m.artist_name || year;
  if (it.item_type === 'podcast_series') return m.author || m.artist_name || year;
  return year;
}

// Per-vertical type glyph for the top-left cover badge — mirrors the in-app
// GridCard VERTICAL_ICONS (Ionicons: film / book / musical-notes / mic / tv).
// White line glyph on a 65%-black chip, same as the app's typeBadge.
function typeBadgeHtml(itemType: string): string {
  const ICONS: Record<string, string> = {
    movie: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5V19M17 5V19M3 9.5H7M17 9.5H21M3 14.5H7M17 14.5H21"/>',
    tv_series: '<rect x="2.5" y="5" width="19" height="12" rx="2"/><path d="M8 20.5H16M12 17V20.5"/>',
    tv_show: '<rect x="2.5" y="5" width="19" height="12" rx="2"/><path d="M8 20.5H16M12 17V20.5"/>',
    book: '<path d="M6.5 3H20V19H6.5A2.5 2.5 0 0 0 4 21.5V5.5A2.5 2.5 0 0 1 6.5 3Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    album: '<circle cx="7" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/><path d="M9.5 17.5V6.5L20 4.5V15.5"/>',
    podcast_series: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11A6.5 6.5 0 0 0 18.5 11M12 17.5V21M8.5 21H15.5"/>',
    book_series: '<path d="M6.5 3H20V19H6.5A2.5 2.5 0 0 0 4 21.5V5.5A2.5 2.5 0 0 1 6.5 3Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
  };
  const glyph = ICONS[itemType];
  if (!glyph) return '';
  return `<div class="cover-type-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></div>`;
}

// The web share page for a board item, by vertical. Movies have their own
// `/movie` route keyed by the TMDB external_id; books + albums route through
// `/item/[id]?type=` keyed by the canonical items.id UUID (mirrors the shapes the
// app emits — app `src/shared/utils/share.ts`). Verticals without a web page yet
// (podcast, tv) return null so the tile renders un-linked, never as a dead link.
function itemShareHref(it: NonNullable<BoardItemRow['items']>, itemId: string): string | null {
  switch (it.item_type) {
    case 'movie':
      return `/movie/${encodeURIComponent(it.external_id)}`;
    case 'book':
      return `/item/${encodeURIComponent(itemId)}?type=book`;
    case 'album':
      return `/item/${encodeURIComponent(itemId)}?type=album`;
    case 'podcast_series':
      return `/item/${encodeURIComponent(itemId)}?type=podcast`;
    case 'tv_series':
      return `/item/${encodeURIComponent(itemId)}?type=tv`;
    default:
      return null;
  }
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
      path: `board_items?board_id=eq.${encodeURIComponent(boardId)}&select=added_at,item_id,items(title,image_url,external_id,item_type,release_date,metadata)&order=position.asc&limit=20`,
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

  // The per-vertical type badge disambiguates a movie tile from a book tile on
  // a MIXED board. On a single-vertical board every tile carries the same glyph
  // — pure noise — so only show it when the board spans more than one vertical.
  const showTypeBadge = new Set(items.map((it) => it.item_type)).size > 1;

  const ogTitle = board.name;
  const ogDescription = `${count} ${count === 1 ? 'item' : 'items'} curated by ${creator}`;
  const ogImage = board.cover_url || bigCoverForItem(items[0] ?? null);

  const gridHtml = sortedRows
    .filter((bi): bi is BoardItemRow & { items: NonNullable<BoardItemRow['items']> } => !!bi.items)
    .map((bi) => {
      const it = bi.items;
      const cover = gridCoverForItem(it);
      const isSquare = SQUARE_TYPES.has(it.item_type);
      const title = escapeHtml(it.title);
      const subtitle = escapeHtml(gridSubtitleForItem(it));
      // Tap-through to the item's share page when its vertical has one (movie /
      // book / album). Others render as a plain div — no dead links.
      const href = itemShareHref(it, bi.item_id);
      const tag = href ? 'a' : 'div';
      const hrefAttr = href ? ` href="${escapeAttr(href)}"` : '';
      const cls = `cover-tile${isSquare ? ' cover-tile--square' : ''}${href ? ' cover-tile--link' : ''}`;
      const badge = showTypeBadge ? typeBadgeHtml(it.item_type) : '';
      if (!cover) {
        return `
        <${tag} class="${cls}"${hrefAttr}>
          <div class="cover-img cover-img--placeholder"><span>${title}</span></div>
          ${badge}
        </${tag}>`;
      }
      const captionSub = subtitle ? `<div class="cover-caption-sub">${subtitle}</div>` : '';
      return `
        <${tag} class="${cls}"${hrefAttr}>
          <img src="${cover}" alt="${title}" class="cover-img" loading="lazy" />
          <div class="cover-scrim" aria-hidden="true"></div>
          ${badge}
          <div class="cover-caption"><div class="cover-caption-title">${title}</div>${captionSub}</div>
        </${tag}>`;
    })
    .join('');

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    showStickyBar: true,
    wide: true,
    boardLayout: true,
    body: `
      <div class="board-hero">
        <h1 class="board-title">${escapeHtml(board.name)}</h1>
        <p class="board-byline">by ${escapeHtml(creator)}</p>
        ${board.description ? `<p class="board-desc">${escapeHtml(board.description)}</p>` : ''}
      </div>
      ${gridHtml ? `<div class="board-grid" id="board-grid">${gridHtml}</div>` : '<p class="empty">This board is empty</p>'}
    `,
  });

  return htmlResponse(html, 3600);
};
