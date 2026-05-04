import { escapeHtml, htmlResponse, notFoundPage, renderPage, type ModalContext } from '../_lib/template';
import { sbFetchOne, type SupabaseEnv } from '../_lib/supabase';
import { lookupSharer } from '../_lib/sharer';

type Env = SupabaseEnv;

type DbBook = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  external_source: string | null;
  metadata: {
    authors?: string[];
    isbn?: string;
    isbn_13?: string;
    google_books_id?: string;
    publishedDate?: string;
    categories?: string[];
    pageCount?: number;
    publisher?: string;
    // S139 — multi-source cover registry written by the resolver at ingest.
    image_sources?: Array<{ url: string; source: string; priority: number; license?: string }>;
  } | null;
};

type GoogleBook = {
  volumeInfo: {
    title: string;
    authors?: string[];
    description?: string;
    publishedDate?: string;
    categories?: string[];
    publisher?: string;
    pageCount?: number;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: {
      thumbnail?: string;
      small?: string;
      medium?: string;
      large?: string;
      smallThumbnail?: string;
    };
  };
};

function pickBestCover(links?: GoogleBook['volumeInfo']['imageLinks']): string {
  if (!links) return '';
  const url = links.large || links.medium || links.small || links.thumbnail || links.smallThumbnail || '';
  return url.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
}

function openLibraryCover(isbn?: string): string {
  if (!isbn) return '';
  const clean = isbn.replace(/[^0-9Xx]/g, '');
  return clean ? `https://covers.openlibrary.org/b/isbn/${clean}-L.jpg?default=false` : '';
}

// S139 — pick the first working cover URL out of the resolver's persisted
// chain. Server-side mirror of the client's SmartCover ladder.
function pickFromImageSources(
  sources: Array<{ url: string; priority: number }> | undefined,
): string {
  if (!sources || sources.length === 0) return '';
  const sorted = [...sources].sort((a, b) => a.priority - b.priority);
  return sorted[0]?.url ?? '';
}

function pickIsbn(ids?: { type: string; identifier: string }[]): string {
  if (!ids) return '';
  return (
    ids.find((i) => i.type === 'ISBN_13')?.identifier ||
    ids.find((i) => i.type === 'ISBN_10')?.identifier ||
    ''
  );
}

// S140 — Theo-of-Golden bug fix. The same book can exist in our DB under
// multiple identifier shapes: NYT ingest stores `isbn-{n}`, Google Books
// ingest stores the GB volume_id, OL ingest stores `ol:edition:OLxxxM`.
// The receiver's app generates a share URL with whichever identifier the
// app saw — which won't always match what's in our DB. Try every shape we
// know about before giving up.
async function multiLookupBook(env: Env, id: string): Promise<DbBook | null> {
  // Direct external_id hit (covers NYT-ingested isbn-* rows + native GB IDs)
  const direct = await sbFetchOne<DbBook>(env, {
    path: `items?external_id=eq.${encodeURIComponent(id)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=1`,
    key: 'service',
  });
  if (direct) return direct;

  // If the id LOOKS like an ISBN (digits + maybe X), try `isbn-{id}` shape
  const looksLikeIsbn = /^\d{9}[\dXx]$|^\d{13}$/.test(id);
  if (looksLikeIsbn) {
    const isbnShape = await sbFetchOne<DbBook>(env, {
      path: `items?external_id=eq.${encodeURIComponent('isbn-' + id)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=1`,
      key: 'service',
    });
    if (isbnShape) return isbnShape;
  }

  // Otherwise the id is probably a Google Books volume_id — try matching
  // the metadata->google_books_id field on any book row.
  const byGbId = await sbFetchOne<DbBook>(env, {
    path: `items?metadata->>google_books_id=eq.${encodeURIComponent(id)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=1`,
    key: 'service',
  });
  if (byGbId) return byGbId;

  return null;
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const volumeId = String(params.id);
  const url = new URL(request.url);
  const ogUrl = url.toString();
  const fromUserId = url.searchParams.get('from');

  const sharerPromise = lookupSharer(env, fromUserId);

  // 1. Multi-shape DB lookup (Theo-of-Golden fix)
  const item = await multiLookupBook(env, volumeId);

  if (item) {
    const authors = item.metadata?.authors ?? [];
    const isbn = item.metadata?.isbn ?? item.metadata?.isbn_13;
    const fromChain = pickFromImageSources(item.metadata?.image_sources);
    const cover = item.image_url || fromChain || openLibraryCover(isbn);
    const sharer = await sharerPromise;

    return renderBook({
      title: item.title,
      authors,
      description: item.description ?? '',
      cover,
      fallbackCover: fromChain || openLibraryCover(isbn),
      publishedDate: item.metadata?.publishedDate ?? '',
      categories: item.metadata?.categories ?? [],
      pageCount: item.metadata?.pageCount ?? null,
      publisher: item.metadata?.publisher ?? '',
      externalId: item.external_id,
      externalSource: item.external_source ?? 'unknown',
      ogUrl,
      sharer,
    });
  }

  // 2. Live Google Books fallback (when in-DB miss + the id is a GB vol_id)
  let gb: GoogleBook | null = null;
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(volumeId)}`);
    if (res.ok) gb = (await res.json()) as GoogleBook;
  } catch {
    /* fall through */
  }

  if (gb && gb.volumeInfo) {
    const info = gb.volumeInfo;
    const isbn = pickIsbn(info.industryIdentifiers);
    const cover = pickBestCover(info.imageLinks) || openLibraryCover(isbn);
    const sharer = await sharerPromise;

    return renderBook({
      title: info.title,
      authors: info.authors ?? [],
      description: info.description ?? '',
      cover,
      fallbackCover: openLibraryCover(isbn),
      publishedDate: info.publishedDate ?? '',
      categories: info.categories ?? [],
      pageCount: info.pageCount ?? null,
      publisher: info.publisher ?? '',
      externalId: volumeId,
      externalSource: 'googlebooks',
      ogUrl,
      sharer,
    });
  }

  // 3. Last-resort Open Library fallback by ID — covers the case when GB
  // is rate-limited (Theo-of-Golden's actual failure mode) AND we can
  // recognize the id as an ISBN or OL key.
  const looksLikeIsbn = /^\d{9}[\dXx]$|^\d{13}$/.test(volumeId);
  if (looksLikeIsbn) {
    try {
      const res = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(volumeId)}.json`);
      if (res.ok) {
        const ol = await res.json() as any;
        const sharer = await sharerPromise;
        return renderBook({
          title: ol.title || 'Unknown title',
          authors: [],
          description: ol.description?.value || ol.description || '',
          cover: openLibraryCover(volumeId),
          fallbackCover: '',
          publishedDate: ol.publish_date || '',
          categories: [],
          pageCount: ol.number_of_pages ?? null,
          publisher: (ol.publishers && ol.publishers[0]) || '',
          externalId: 'isbn-' + volumeId,
          externalSource: 'openlibrary',
          ogUrl,
          sharer,
        });
      }
    } catch {
      /* fall through */
    }
  }

  return notFoundPage('Book not found');
};

type RenderArgs = {
  title: string;
  authors: string[];
  description: string;
  cover: string;
  fallbackCover: string;
  publishedDate: string;
  categories: string[];
  pageCount: number | null;
  publisher: string;
  externalId: string;
  externalSource: string;
  ogUrl: string;
  sharer: Awaited<ReturnType<typeof lookupSharer>>;
};

function renderBook(a: RenderArgs): Response {
  const year = a.publishedDate ? a.publishedDate.slice(0, 4) : '';
  const authorStr = a.authors[0] ?? '';
  const allAuthors = a.authors.length ? a.authors.join(', ') : '';
  const pagesStr = a.pageCount ? `${a.pageCount} pages` : '';

  const ogTitle = authorStr ? `${a.title} by ${authorStr}` : a.title;
  const cleanDesc = a.description ? a.description.replace(/<[^>]+>/g, '') : '';
  const ogDescription = cleanDesc
    ? cleanDesc.slice(0, 150) + (cleanDesc.length > 150 ? '…' : '')
    : 'Discover this book on Tastely';

  const modalContext: ModalContext = {
    itemTitle: a.title,
    itemType: 'book',
    externalId: a.externalId,
    externalSource: a.externalSource,
    saveCtaLabel: `Save ${a.title} to your library`,
  };

  const metaParts = [year, pagesStr, a.publisher].filter(Boolean);
  const metaLine = metaParts.length
    ? metaParts.map((s) => escapeHtml(s)).join(' <span class="dot">·</span> ')
    : '';

  const categoriesHtml = a.categories.length
    ? `<div class="section">
         <p class="section-label">Categories</p>
         <div class="providers">
           ${a.categories
             .slice(0, 5)
             .map((c) => `<span class="provider-chip">${escapeHtml(c)}</span>`)
             .join('')}
         </div>
       </div>`
    : '';

  const coverImg = a.cover
    ? `<img src="${escapeHtml(a.cover)}" alt="${escapeHtml(a.title)}" class="detail-cover" ${a.fallbackCover ? `onerror="this.onerror=null;this.src='${escapeHtml(a.fallbackCover)}'"` : ''} />`
    : '<div class="detail-cover"></div>';

  const body = `
    <div class="detail-hero">
      <p class="detail-eyebrow">Book</p>
      ${coverImg}
      <h1 class="detail-title">${escapeHtml(a.title)}</h1>
      ${allAuthors ? `<p class="detail-subtitle">by ${escapeHtml(allAuthors)}</p>` : ''}
      ${metaLine ? `<p class="detail-meta">${metaLine}</p>` : ''}
    </div>

    <div class="actions">
      <button class="pill" type="button" data-share-action="save">
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 5C5 3.9 5.9 3 7 3H17C18.1 3 19 3.9 19 5V21L12 17.5L5 21V5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Save
      </button>
      <button class="pill" type="button" data-share-action="board">
        <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="2"/><path d="M3 10H21" stroke="currentColor" stroke-width="2"/></svg>
        Board
      </button>
      <button class="pill" type="button" data-share-action="send">
        <svg viewBox="0 0 24 24" fill="none"><path d="M3 12L21 3L17 21L13 14L3 12Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Send
      </button>
      <button class="pill" type="button" data-share-action="share">
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 3V15M12 3L7 8M12 3L17 8M5 21H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Share
      </button>
    </div>

    ${cleanDesc ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(cleanDesc)}</p>
    </div>` : ''}

    ${categoriesHtml}
  `;

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage: a.cover || a.fallbackCover,
    ogUrl: a.ogUrl,
    sharer: a.sharer,
    modalContext,
    body,
  });

  return htmlResponse(html, 86400);
}
