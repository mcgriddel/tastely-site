import { escapeAttr, escapeHtml, htmlResponse, notFoundPage, renderActionRow, renderPage, type ModalContext } from '../_lib/template';
import { sbFetch, sbFetchOne, type SupabaseEnv } from '../_lib/supabase';
import { lookupSharer } from '../_lib/sharer';
import {
  resolveWatchProviders,
  renderWatchSection,
  type CachedWatchProvidersByRegion,
  type WatchProvidersOut,
} from '../_lib/watchProviders';

type Env = SupabaseEnv & { TMDB_API_KEY?: string };

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
    // S139 NYT bestseller substrate — when present, NYT's `book_image` is
    // higher-quality than the OL cover the resolver typically lands.
    nyt_lists?: Array<{ book_image?: string; rank?: number }>;
    // S140 — NYT bestseller substrate ships affiliate retailer links
    // (Amazon, Apple Books, B&N, Books-A-Million, Bookshop.org).
    // Surfacing on the share-landing per Mac's S140 polish punch list.
    buy_links?: Array<{ name: string; url: string }>;
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

// iMessage / Open Graph unfurlers do NOT follow HTTP redirects when fetching
// og:image — they take the URL as-is. Open Library cover URLs (our priority-1
// book-cover source) now 302-redirect to archive.org, and Wikidata FilePath
// covers 302 to Commons; a non-following fetcher gets a redirect stub instead
// of an image, so the preview card renders no picture. Resolve the og:image to
// its final, directly-fetchable URL so the card always shows the cover. The
// in-page <img> is left on the original URL — browsers follow redirects fine.
async function resolveOgImageUrl(url: string): Promise<string> {
  if (!url) return url;
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { Range: 'bytes=0-0' } });
    if (res.ok && res.url) return res.url;
  } catch {
    /* network failure — emit the original URL unchanged */
  }
  return url;
}

function pickIsbn(ids?: { type: string; identifier: string }[]): string {
  if (!ids) return '';
  return (
    ids.find((i) => i.type === 'ISBN_13')?.identifier ||
    ids.find((i) => i.type === 'ISBN_10')?.identifier ||
    ''
  );
}

// NYT bestseller substrate stores book titles in ALL CAPS ("THEO OF GOLDEN")
// while every other source uses proper Title Case ("Theo of Golden"). Smart
// title-case helper that ONLY fires when the input is entirely uppercase —
// preserves correctly-cased acronyms (iOS, USA, NASA in normal mixed-case
// titles aren't touched). When the whole string is upper, we treat it as the
// NYT artifact and properly case it with English minor-word rules.
function properCaseTitle(s: string): string {
  if (!s) return s;
  // If string has any lowercase letter, leave it alone.
  if (s !== s.toUpperCase()) return s;
  // If string has no letters at all (numbers / punctuation), leave it.
  if (!/[A-Z]/.test(s)) return s;
  const minor = new Set([
    'a','an','the','and','but','or','nor','for','yet','so',
    'as','at','by','from','in','of','off','on','onto','to','up','via','with',
  ]);
  return s.toLowerCase().split(/\s+/).map((word, i, arr) => {
    // First/last word always cap; first word after a colon/sentence break caps.
    const afterBreak = i > 0 && /[:.?!—–]$/.test(arr[i - 1]);
    if (i > 0 && i < arr.length - 1 && !afterBreak && minor.has(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

// S140 — Theo-of-Golden bug fix. The same book can exist in our DB under
// multiple identifier shapes: NYT ingest stores `isbn-{n}`, Google Books
// ingest stores the GB volume_id, OL ingest stores `ol:edition:OLxxxM`.
// The receiver's app generates a share URL with whichever identifier the
// app saw — which won't always match what's in our DB. Try every shape we
// know about before giving up.
async function multiLookupBook(env: Env, id: string): Promise<DbBook | null> {
  // Internal item UUID (items.id primary key). The app shares links by this
  // stable internal id — the most reliable identifier, since external_ids
  // vary by source/edition (the Theo-of-Golden problem). Try it first.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (isUuid) {
    const byUuid = await sbFetchOne<DbBook>(env, {
      path: `items?id=eq.${encodeURIComponent(id)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=1`,
      key: 'service',
    });
    if (byUuid) return byUuid;
  }

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

  // Type-aware dispatch. This route was originally book-only; the app now shares
  // albums (and eventually podcasts/TV) through the same `/item/[id]` URL with a
  // `?type=` discriminator (see app `src/shared/utils/share.ts`). Route non-book
  // types to their renderer; book stays the default so legacy `/item/[id]?type=book`
  // — and any older un-typed book link — keeps working unchanged.
  const shareType = url.searchParams.get('type');
  if (shareType === 'album') {
    return await renderAlbumRoute(env, volumeId, ogUrl, sharerPromise);
  }
  if (shareType === 'podcast') {
    return await renderPodcastRoute(env, volumeId, ogUrl, sharerPromise);
  }
  if (shareType === 'tv') {
    // CF edges set request.cf.country to the viewer's 2-letter ISO — region for
    // watch providers (same approach as the movie route).
    const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? 'US';
    return await renderTvRoute(env, volumeId, ogUrl, sharerPromise, country);
  }

  // 1. Multi-shape DB lookup (Theo-of-Golden fix)
  const item = await multiLookupBook(env, volumeId);

  if (item) {
    const authors = item.metadata?.authors ?? [];
    const isbn = item.metadata?.isbn ?? item.metadata?.isbn_13;
    const fromChain = pickFromImageSources(item.metadata?.image_sources);
    // S140 — NYT cover fallback. Books ingested via NYT bestseller substrate
    // have higher-quality covers in `metadata.nyt_lists[].book_image` than
    // OL's ISBN endpoint sometimes serves (Theo of Golden case: OL returned
    // a wrong scribbled image). Prefer NYT when the canonical `image_url`
    // points at OL and a NYT image is present in metadata.
    const nytCover = item.metadata?.nyt_lists?.[0]?.book_image ?? '';
    const isOlCanonical = (item.image_url ?? '').includes('covers.openlibrary.org');
    const cover = (isOlCanonical && nytCover)
      ? nytCover
      : (item.image_url || nytCover || fromChain || openLibraryCover(isbn));
    const sharer = await sharerPromise;

    return await renderBook({
      title: properCaseTitle(item.title),
      authors,
      description: item.description ?? '',
      cover,
      fallbackCover: nytCover || fromChain || openLibraryCover(isbn),
      publishedDate: item.metadata?.publishedDate ?? '',
      categories: item.metadata?.categories ?? [],
      pageCount: item.metadata?.pageCount ?? null,
      publisher: item.metadata?.publisher ?? '',
      isbn: isbn ?? null,
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

    // S140 — second-chance DB lookup. The multi-shape lookup at the top of
    // this function only knows the volume_id; we now have the ISBN(s) +
    // title + author from GB. Try BOTH paths to find a matching DB row:
    //   1. By any ISBN GB returned (ISBN_13 or ISBN_10) — covers the case
    //      where GB and our DB happen to use the same edition's ISBN.
    //   2. By (title + first author) — covers Theo-of-Golden-class cases
    //      where GB and our DB carry different ISBNs for different editions
    //      of the same book.
    // If found, prefer DB metadata (NYT covers, image_sources chain) over
    // what GB returns — both OL and GB are unreliable for some bestsellers.
    let dbRow: DbBook | null = null;

    // Path 1: try every ISBN GB returned
    const allIsbns = (info.industryIdentifiers ?? [])
      .map((i) => i.identifier)
      .filter(Boolean);
    for (const candidate of allIsbns) {
      dbRow = await sbFetchOne<DbBook>(env, {
        path: `items?external_id=eq.${encodeURIComponent('isbn-' + candidate)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=1`,
        key: 'service',
      });
      if (dbRow) break;
    }

    // Path 2: title + first author lookup. Postgrest `ilike` for case-
    // insensitive match. Authors check via metadata->>authors substring
    // (cheap, good enough for first-author match).
    if (!dbRow && info.title && info.authors && info.authors.length > 0) {
      const titleQuery = info.title.replace(/[%_]/g, '\\$&');
      const firstAuthor = info.authors[0];
      const candidates = await sbFetch<DbBook>(env, {
        path: `items?title=ilike.${encodeURIComponent(titleQuery)}&item_type=eq.book&select=title,description,image_url,external_id,external_source,metadata&limit=5`,
        key: 'service',
      });
      if (candidates) {
        dbRow = candidates.find((row) => {
          const dbAuthors = row.metadata?.authors ?? [];
          return dbAuthors.some(
            (a) => a.toLowerCase() === firstAuthor.toLowerCase(),
          );
        }) ?? null;
      }
    }

    if (dbRow) {
      const authors = dbRow.metadata?.authors ?? info.authors ?? [];
      const fromChain = pickFromImageSources(dbRow.metadata?.image_sources);
      const nytCover = dbRow.metadata?.nyt_lists?.[0]?.book_image ?? '';
      const isOlCanonical = (dbRow.image_url ?? '').includes('covers.openlibrary.org');
      const cover = (isOlCanonical && nytCover)
        ? nytCover
        : (dbRow.image_url || nytCover || fromChain || pickBestCover(info.imageLinks) || openLibraryCover(isbn));
      // Prefer GB's full publisher description (matches in-app behavior —
      // app's useBookDetail hook fetches from getBookDetail/googlebooks).
      // Our DB row's description for NYT-ingested books is just the short
      // bestseller blurb. Fall back to DB only if GB has nothing.
      const description = info.description || dbRow.description || '';
      const sharer = await sharerPromise;
      return await renderBook({
        // Prefer GB's title (proper case) over DB's (often NYT all-caps).
        title: properCaseTitle(info.title || dbRow.title),
        authors,
        description,
        cover,
        fallbackCover: nytCover || pickBestCover(info.imageLinks) || openLibraryCover(isbn),
        publishedDate: dbRow.metadata?.publishedDate ?? info.publishedDate ?? '',
        categories: dbRow.metadata?.categories ?? info.categories ?? [],
        pageCount: dbRow.metadata?.pageCount ?? info.pageCount ?? null,
        publisher: dbRow.metadata?.publisher ?? info.publisher ?? '',
        isbn: dbRow.metadata?.isbn ?? dbRow.metadata?.isbn_13 ?? isbn ?? null,
        externalId: dbRow.external_id,
        externalSource: dbRow.external_source ?? 'unknown',
        ogUrl,
        sharer,
      });
    }

    // Pure GB render (no DB row found by either path)
    const cover = pickBestCover(info.imageLinks) || openLibraryCover(isbn);
    const sharer = await sharerPromise;

    return await renderBook({
      title: properCaseTitle(info.title),
      authors: info.authors ?? [],
      description: info.description ?? '',
      cover,
      fallbackCover: openLibraryCover(isbn),
      publishedDate: info.publishedDate ?? '',
      categories: info.categories ?? [],
      pageCount: info.pageCount ?? null,
      publisher: info.publisher ?? '',
      isbn: isbn ?? null,
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
        return await renderBook({
          title: properCaseTitle(ol.title || 'Unknown title'),
          authors: [],
          description: ol.description?.value || ol.description || '',
          cover: openLibraryCover(volumeId),
          fallbackCover: '',
          publishedDate: ol.publish_date || '',
          categories: [],
          pageCount: ol.number_of_pages ?? null,
          publisher: (ol.publishers && ol.publishers[0]) || '',
          isbn: volumeId,
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
  isbn: string | null;
  externalId: string;
  externalSource: string;
  ogUrl: string;
  sharer: Awaited<ReturnType<typeof lookupSharer>>;
};

// Strip HTML from a description but preserve paragraph/line breaks as
// newlines. Google Books descriptions arrive with <br>, <p>, etc.
// separating review-quote blocks from the synopsis; naive tag-stripping
// runs words together (e.g. "KotbOne"). Output renders cleanly when the
// element has `white-space: pre-line`.
function stripHtmlPreservingBreaks(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function renderBook(a: RenderArgs): Promise<Response> {
  const year = a.publishedDate ? a.publishedDate.slice(0, 4) : '';
  const authorStr = a.authors[0] ?? '';
  const allAuthors = a.authors.length ? a.authors.join(', ') : '';
  const pagesStr = a.pageCount ? `${a.pageCount} pages` : '';

  const ogTitle = authorStr ? `${a.title} by ${authorStr}` : a.title;
  const cleanDesc = a.description ? stripHtmlPreservingBreaks(a.description) : '';
  // OG description doesn't want line breaks (iMessage / unfurlers render
  // it as a single line). Collapse newlines for the meta tag only.
  const ogDescriptionSrc = cleanDesc.replace(/\s*\n+\s*/g, ' ');
  const ogDescription = ogDescriptionSrc
    ? ogDescriptionSrc.slice(0, 150) + (ogDescriptionSrc.length > 150 ? '…' : '')
    : 'Discover this book on Tastely';

  const modalContext: ModalContext = {
    itemTitle: a.title,
    itemType: 'book',
    externalId: a.externalId,
    externalSource: a.externalSource,
    saveCtaLabel: `Save ${a.title} to your library`,
  };

  // Publisher dropped per Mac's S140 polish call — imprint names like
  // "Atria" (S&S imprint) are informationally correct but unfamiliar.
  // Keep meta line minimal: year + pages.
  const metaParts = [year, pagesStr].filter(Boolean);
  const metaLine = metaParts.length
    ? metaParts.map((s) => escapeHtml(s)).join(' <span class="dot">·</span> ')
    : '';

  // Categories suppressed per Mac's S140 polish call — Google Books'
  // categories are noisy ("Fiction / Literary", "Fiction / Romance / Small
  // Town & Rural", etc.) and don't add receiver-page value. Re-enable by
  // restoring this block + the `${categoriesHtml}` reference below.
  const categoriesHtml = '';

  const coverImg = a.cover
    ? `<img src="${escapeHtml(a.cover)}" alt="${escapeHtml(a.title)}" class="detail-cover" ${a.fallbackCover ? `onerror="this.onerror=null;this.src='${escapeHtml(a.fallbackCover)}'"` : ''} />`
    : '<div class="detail-cover"></div>';

  // Where to read — canonical retailer set, built from the book's ISBN-13 +
  // title to MIRROR the in-app shared util (app/src/modules/books/utils/
  // bookRetailers.ts) so the share page and the app never drift. Keep the two
  // in sync: same retailer set, same order, same URL logic, same logos.
  //
  // We build our OWN clean links from the ISBN — NOT NYT's `buy_links` (those
  // are affiliate-redirect wrappers carrying NYT's attribution tags). ISBN-
  // direct where the retailer exposes one (B&N ?ean=, Bookshop /book/, Apple
  // goto-gateway); ISBN/title search otherwise. Apple Books only when we have an
  // ISBN (no clean search fallback). Logos are the same 64×64 brand tiles the
  // app bundles, served locally from /retailers/*.png.
  //
  // Affiliate attribution choke-point: applyAffiliate() is identity today
  // (clean links, no tags). When Tastely joins retailer programs, inject tags
  // HERE only — and mirror the change in the app util.
  const applyAffiliate = (_key: string, url: string): string => url;

  const normalizeIsbn = (raw: string | null): string | null => {
    if (!raw) return null;
    const s = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
    return s.length === 10 || s.length === 13 ? s : null;
  };

  type RetailerSpec = { key: string; label: string; build: (isbn: string | null, q: string) => string | null };
  const RETAILERS: RetailerSpec[] = [
    { key: 'amazon', label: 'Amazon', build: (isbn, q) => `https://www.amazon.com/s?k=${isbn ?? q}&i=stripbooks` },
    { key: 'kindle', label: 'Kindle', build: (_isbn, q) => `https://www.amazon.com/s?k=${q}&i=digital-text` },
    { key: 'applebooks', label: 'Apple Books', build: (isbn) => (isbn ? `https://goto.applebooks.apple/${isbn}` : null) },
    { key: 'barnesandnoble', label: 'Barnes & Noble', build: (isbn, q) => (isbn ? `https://www.barnesandnoble.com/w/?ean=${isbn}` : `https://www.barnesandnoble.com/s/${q}`) },
    { key: 'bookshop', label: 'Bookshop.org', build: (isbn, q) => (isbn ? `https://bookshop.org/book/${isbn}` : `https://bookshop.org/search?keywords=${q}`) },
    { key: 'booksamillion', label: 'Books-A-Million', build: (isbn, q) => `https://www.booksamillion.com/search?query=${isbn ?? q}` },
    { key: 'audible', label: 'Audible', build: (_isbn, q) => `https://www.audible.com/search?keywords=${q}` },
  ];

  const retailerIsbn = normalizeIsbn(a.isbn);
  const retailerQ = encodeURIComponent(a.title + (a.authors[0] ? ' ' + a.authors[0] : ''));
  const retailerLinks = RETAILERS
    .map((s) => {
      const url = s.build(retailerIsbn, retailerQ);
      return url ? { key: s.key, label: s.label, url: applyAffiliate(s.key, url) } : null;
    })
    .filter((x): x is { key: string; label: string; url: string } => x !== null);

  const buyLinksHtml = retailerLinks.length
    ? `<div class="section">
         <p class="section-label">Where to read</p>
         <div class="providers">
           ${retailerLinks
             .map(
               (r) =>
                 `<a class="provider-chip provider-chip--link" href="${escapeAttr(r.url)}" target="_blank" rel="nofollow noopener"><img src="/retailers/${r.key}.png" alt="" class="provider-icon" loading="lazy" />${escapeHtml(r.label)}</a>`,
             )
             .join('')}
         </div>
       </div>`
    : '';

  const body = `
    <div class="detail-hero">
      ${coverImg}
      <h1 class="detail-title">${escapeHtml(a.title)}</h1>
      ${allAuthors ? `<p class="detail-subtitle">by ${escapeHtml(allAuthors)}</p>` : ''}
      ${metaLine ? `<p class="detail-meta">${metaLine}</p>` : ''}
    </div>

    ${renderActionRow()}

    ${cleanDesc ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(cleanDesc)}</p>
    </div>` : ''}

    ${buyLinksHtml}

    ${categoriesHtml}
  `;

  const ogImage = await resolveOgImageUrl(a.cover || a.fallbackCover);

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl: a.ogUrl,
    sharer: a.sharer,
    modalContext,
    body,
  });

  return htmlResponse(html, 86400);
}

// ─────────────────────────────────────────────────────────────────────────
// Album (?type=album)
//
// Mirrors the book renderer's shape (shared chrome via renderPage; detail-hero +
// action pills + "Where to listen" providers + About) so the album share-landing
// is visually consistent with the movie + book pages. The "Where to listen" links
// are CUSTOM per-platform SEARCH-URLs built from artist + title — a 1:1 port of the
// in-app chooser (`app/src/modules/music/components/MusicListenCTAs.tsx`). Keep the
// two in sync: same platform set, same order, same URL logic, same logos.
// ─────────────────────────────────────────────────────────────────────────

type DbAlbum = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  external_source: string | null;
  release_date: string | null;
  metadata: {
    artist_name?: string;
    genres?: string[];
  } | null;
};

// Logo `key` MUST match the PNG filename served from /retailers/*.png.
const MUSIC_PLATFORMS: { key: string; label: string; url: (q: string) => string }[] = [
  { key: 'spotify', label: 'Spotify', url: (q) => `https://open.spotify.com/search/${q}` },
  { key: 'applemusic', label: 'Apple Music', url: (q) => `https://music.apple.com/us/search?term=${q}` },
  { key: 'youtubemusic', label: 'YouTube Music', url: (q) => `https://music.youtube.com/search?q=${q}` },
  { key: 'amazonmusic', label: 'Amazon Music', url: (q) => `https://music.amazon.com/search/${q}` },
  { key: 'tidal', label: 'Tidal', url: (q) => `https://tidal.com/search?q=${q}` },
];

async function lookupAlbum(env: Env, id: string): Promise<DbAlbum | null> {
  const cols = 'title,description,image_url,external_id,external_source,release_date,metadata';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  // The app shares albums by canonical items.id UUID (substrate-first); try it
  // first, then fall back to external_id (mbid:release-group:<uuid>).
  if (isUuid) {
    const byUuid = await sbFetchOne<DbAlbum>(env, {
      path: `items?id=eq.${encodeURIComponent(id)}&item_type=eq.album&select=${cols}&limit=1`,
      key: 'service',
    });
    if (byUuid) return byUuid;
  }
  return await sbFetchOne<DbAlbum>(env, {
    path: `items?external_id=eq.${encodeURIComponent(id)}&item_type=eq.album&select=${cols}&limit=1`,
    key: 'service',
  });
}

async function renderAlbumRoute(
  env: Env,
  id: string,
  ogUrl: string,
  sharerPromise: ReturnType<typeof lookupSharer>,
): Promise<Response> {
  const album = await lookupAlbum(env, id);
  if (!album) return notFoundPage('Album not found');
  const sharer = await sharerPromise;
  return await renderAlbum(album, ogUrl, sharer);
}

async function renderAlbum(
  album: DbAlbum,
  ogUrl: string,
  sharer: Awaited<ReturnType<typeof lookupSharer>>,
): Promise<Response> {
  const artist = album.metadata?.artist_name ?? '';
  const year = album.release_date ? album.release_date.slice(0, 4) : '';
  const genres = (album.metadata?.genres ?? [])
    .slice(0, 3)
    .map((g) => g.replace(/\b\w/g, (c) => c.toUpperCase()));
  const cover = album.image_url ? album.image_url.replace(/^http:/, 'https:') : '';

  const ogTitle = artist ? `${album.title} by ${artist}` : album.title;
  const cleanDesc = album.description ? stripHtmlPreservingBreaks(album.description) : '';
  const ogDescriptionSrc = cleanDesc.replace(/\s*\n+\s*/g, ' ');
  const ogDescription = ogDescriptionSrc
    ? ogDescriptionSrc.slice(0, 150) + (ogDescriptionSrc.length > 150 ? '…' : '')
    : 'Discover this album on Tastely';

  const modalContext: ModalContext = {
    itemTitle: album.title,
    itemType: 'album',
    externalId: album.external_id,
    externalSource: album.external_source ?? 'musicbrainz',
    saveCtaLabel: `Save ${album.title} to your library`,
  };

  const metaLine = [year, ...genres]
    .filter(Boolean)
    .map((s) => escapeHtml(s))
    .join(' <span class="dot">·</span> ');

  const coverImg = cover
    ? `<img src="${escapeAttr(cover)}" alt="${escapeAttr(album.title)}" class="detail-cover detail-cover-album" />`
    : '<div class="detail-cover detail-cover-album"></div>';

  // "Where to listen" — search-URL chips, mirroring the book "Where to read" row.
  const listenQ = encodeURIComponent([artist, album.title].filter(Boolean).join(' ').trim());
  const listenHtml = listenQ
    ? `<div class="section">
         <p class="section-label">Where to listen</p>
         <div class="providers">
           ${MUSIC_PLATFORMS.map(
             (p) =>
               `<a class="provider-chip provider-chip--link" href="${escapeAttr(p.url(listenQ))}" target="_blank" rel="nofollow noopener"><img src="/retailers/${p.key}.png" alt="" class="provider-icon" loading="lazy" />${escapeHtml(p.label)}</a>`,
           ).join('')}
         </div>
       </div>`
    : '';

  const body = `
    <div class="detail-hero">
      ${coverImg}
      <h1 class="detail-title">${escapeHtml(album.title)}</h1>
      ${artist ? `<p class="detail-subtitle">by ${escapeHtml(artist)}</p>` : ''}
      ${metaLine ? `<p class="detail-meta">${metaLine}</p>` : ''}
    </div>

    ${renderActionRow()}

    ${cleanDesc ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(cleanDesc)}</p>
    </div>` : ''}

    ${listenHtml}
  `;

  const ogImage = await resolveOgImageUrl(cover);

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    sharer,
    modalContext,
    body,
  });

  return htmlResponse(html, 86400);
}

// ─────────────────────────────────────────────────────────────────────────
// TV (?type=tv)
//
// Same shared chrome as the movie page. TV `items` rows are sparse (title /
// description / cover only — no genres, date, or watch-provider cache), so
// genres + year + region-aware watch providers are filled from TMDB live (the
// worker carries TMDB_API_KEY, same as the movie route). "Where to watch" routes
// through the shared `_lib/watchProviders` helper (mediaType 'tv') so it stays in
// lockstep with the movie page.
// ─────────────────────────────────────────────────────────────────────────

const TMDB_IMG = 'https://image.tmdb.org/t/p';

type DbTv = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  external_source: string | null;
  metadata: {
    genres?: string[];
    first_air_date?: string;
    releaseDate?: string;
    creator?: string;
    watch_providers?: CachedWatchProvidersByRegion;
  } | null;
};

type TmdbTv = {
  name: string;
  overview: string;
  poster_path: string | null;
  first_air_date: string;
  genres: { name: string }[];
  created_by: { name: string }[];
};

async function fetchTmdbTv(tmdbId: string, apiKey: string): Promise<TmdbTv | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}?api_key=${apiKey}&language=en-US`,
    );
    if (!res.ok) return null;
    return (await res.json()) as TmdbTv;
  } catch {
    return null;
  }
}

async function lookupTv(env: Env, id: string): Promise<DbTv | null> {
  const cols = 'title,description,image_url,external_id,external_source,metadata';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (isUuid) {
    const byUuid = await sbFetchOne<DbTv>(env, {
      path: `items?id=eq.${encodeURIComponent(id)}&item_type=eq.tv_series&select=${cols}&limit=1`,
      key: 'service',
    });
    if (byUuid) return byUuid;
  }
  return await sbFetchOne<DbTv>(env, {
    path: `items?external_id=eq.${encodeURIComponent(id)}&item_type=eq.tv_series&select=${cols}&limit=1`,
    key: 'service',
  });
}

async function renderTvRoute(
  env: Env,
  id: string,
  ogUrl: string,
  sharerPromise: ReturnType<typeof lookupSharer>,
  country: string,
): Promise<Response> {
  const show = await lookupTv(env, id);
  // Bare TMDB id from external_id (tmdb:tv:{n}); fall back to the URL param if it
  // already looks like a bare numeric id.
  const tmdbId = show?.external_id?.replace(/^tmdb:tv:/, '') ?? (/^\d+$/.test(id) ? id : '');
  const apiKey = env.TMDB_API_KEY;
  // Sparse TV rows → fill genres/year/creator from TMDB.
  const needsTmdb = !show || !show.metadata?.genres?.length;
  const tmdbPromise = tmdbId && apiKey && needsTmdb ? fetchTmdbTv(tmdbId, apiKey) : Promise.resolve(null);
  const watchPromise: Promise<WatchProvidersOut> = tmdbId
    ? resolveWatchProviders({ cache: show?.metadata?.watch_providers, country, tmdbId, apiKey, mediaType: 'tv' })
    : Promise.resolve(null);

  const [sharer, tmdb, watch] = await Promise.all([sharerPromise, tmdbPromise, watchPromise]);
  if (!show && !tmdb) return notFoundPage('Show not found');

  return renderTv({ show, tmdb, tmdbId, watch, ogUrl, sharer });
}

function renderTv(a: {
  show: DbTv | null;
  tmdb: TmdbTv | null;
  tmdbId: string;
  watch: WatchProvidersOut;
  ogUrl: string;
  sharer: Awaited<ReturnType<typeof lookupSharer>>;
}): Response {
  const { show, tmdb } = a;
  const title = show?.title ?? tmdb?.name ?? '';
  const description = show?.description ?? tmdb?.overview ?? '';
  const rawPoster = show?.image_url ?? tmdb?.poster_path ?? null;
  const posterUrl = rawPoster
    ? rawPoster.startsWith('http')
      ? rawPoster.replace(/\/t\/p\/w\d+\//, '/t/p/w500/')
      : `${TMDB_IMG}/w500${rawPoster}`
    : '';
  const dbGenres = show?.metadata?.genres ?? [];
  const genres = dbGenres.length ? dbGenres : (tmdb?.genres ?? []).map((g) => g.name);
  const dateStr =
    show?.metadata?.first_air_date ?? show?.metadata?.releaseDate ?? tmdb?.first_air_date ?? '';
  const year = dateStr ? dateStr.slice(0, 4) : '';
  const creator = show?.metadata?.creator ?? tmdb?.created_by?.[0]?.name ?? '';

  const ogTitle = year ? `${title} (${year})` : title;
  const ogDescription = description
    ? description.slice(0, 150) + (description.length > 150 ? '…' : '')
    : 'Discover this show on Tastely';

  const modalContext: ModalContext = {
    itemTitle: title,
    itemType: 'tv_series',
    externalId: show?.external_id ?? (a.tmdbId ? `tmdb:tv:${a.tmdbId}` : ''),
    externalSource: show?.external_source ?? 'tmdb',
    saveCtaLabel: `Save ${title} to your watchlist`,
  };

  const genreSegment = genres.slice(0, 2).filter(Boolean).join(' / ');
  const metaLine = [year, creator, genreSegment]
    .filter(Boolean)
    .map((s) => escapeHtml(s))
    .join(' <span class="dot">·</span> ');

  const posterImg = posterUrl
    ? `<img src="${escapeAttr(posterUrl)}" alt="${escapeAttr(title)}" class="detail-cover" />`
    : '<div class="detail-cover"></div>';

  const body = `
    <div class="detail-hero">
      ${posterImg}
      <h1 class="detail-title">${escapeHtml(title)}</h1>
      ${metaLine ? `<p class="detail-meta">${metaLine}</p>` : ''}
    </div>

    ${renderActionRow()}

    ${description ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(description)}</p>
    </div>` : ''}

    ${renderWatchSection(a.watch)}
  `;

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage: posterUrl,
    ogUrl: a.ogUrl,
    sharer: a.sharer,
    modalContext,
    body,
  });

  return htmlResponse(html, 86400);
}

// ─────────────────────────────────────────────────────────────────────────
// Podcast (?type=podcast)
//
// Same shared-chrome shape as the album/book renderers. "Where to listen" is a
// 1:1 port of the in-app podcast set (`app/src/modules/podcasts/utils/
// podcastListenLinks.ts`): Apple Podcasts · Spotify · YouTube — prefer the stored
// canonical URL (metadata.apple_url / .youtube_url; Spotify is search-only), fall
// back to a search link, and honor metadata.listen_unavailable. Keep in sync with
// that file (same set, order, URL logic, logos).
// ─────────────────────────────────────────────────────────────────────────

type DbPodcast = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  external_source: string | null;
  metadata: {
    author?: string;
    apple_url?: string;
    spotify_url?: string;
    youtube_url?: string;
    listen_unavailable?: string[];
  } | null;
};

// `key` = the in-app PodcastPlatformKey (for listen_unavailable matching);
// `logo` = the PNG filename served from /retailers/*.png.
const PODCAST_PLATFORMS: {
  key: string;
  logo: string;
  label: string;
  canonical: (m: DbPodcast['metadata']) => string | undefined;
  build: (canonical: string | null, q: string) => string;
}[] = [
  { key: 'apple_podcasts', logo: 'applepodcasts', label: 'Apple Podcasts',
    canonical: (m) => m?.apple_url, build: (c, q) => c ?? `https://podcasts.apple.com/search?term=${q}` },
  { key: 'spotify', logo: 'spotify', label: 'Spotify',
    canonical: (m) => m?.spotify_url, build: (c, q) => c ?? `https://open.spotify.com/search/${q}` },
  { key: 'youtube', logo: 'youtube', label: 'YouTube',
    canonical: (m) => m?.youtube_url, build: (c, q) => c ?? `https://www.youtube.com/results?search_query=${q}` },
];

async function lookupPodcast(env: Env, id: string): Promise<DbPodcast | null> {
  const cols = 'title,description,image_url,external_id,external_source,metadata';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (isUuid) {
    const byUuid = await sbFetchOne<DbPodcast>(env, {
      path: `items?id=eq.${encodeURIComponent(id)}&item_type=eq.podcast_series&select=${cols}&limit=1`,
      key: 'service',
    });
    if (byUuid) return byUuid;
  }
  return await sbFetchOne<DbPodcast>(env, {
    path: `items?external_id=eq.${encodeURIComponent(id)}&item_type=eq.podcast_series&select=${cols}&limit=1`,
    key: 'service',
  });
}

async function renderPodcastRoute(
  env: Env,
  id: string,
  ogUrl: string,
  sharerPromise: ReturnType<typeof lookupSharer>,
): Promise<Response> {
  const show = await lookupPodcast(env, id);
  if (!show) return notFoundPage('Podcast not found');
  const sharer = await sharerPromise;
  return await renderPodcast(show, ogUrl, sharer);
}

async function renderPodcast(
  show: DbPodcast,
  ogUrl: string,
  sharer: Awaited<ReturnType<typeof lookupSharer>>,
): Promise<Response> {
  const author = show.metadata?.author ?? '';
  const cover = show.image_url ? show.image_url.replace(/^http:/, 'https:') : '';

  const ogTitle = author ? `${show.title} by ${author}` : show.title;
  const cleanDesc = show.description ? stripHtmlPreservingBreaks(show.description) : '';
  const ogDescriptionSrc = cleanDesc.replace(/\s*\n+\s*/g, ' ');
  const ogDescription = ogDescriptionSrc
    ? ogDescriptionSrc.slice(0, 150) + (ogDescriptionSrc.length > 150 ? '…' : '')
    : 'Discover this podcast on Tastely';

  const modalContext: ModalContext = {
    itemTitle: show.title,
    itemType: 'podcast_series',
    externalId: show.external_id,
    externalSource: show.external_source ?? 'rss',
    saveCtaLabel: `Save ${show.title} to your library`,
  };

  const coverImg = cover
    ? `<img src="${escapeAttr(cover)}" alt="${escapeAttr(show.title)}" class="detail-cover detail-cover-album" />`
    : '<div class="detail-cover detail-cover-album"></div>';

  const hidden = new Set(show.metadata?.listen_unavailable ?? []);
  const q = encodeURIComponent(show.title);
  const chips = PODCAST_PLATFORMS.filter((p) => !hidden.has(p.key)).map((p) => {
    const url = p.build(p.canonical(show.metadata) ?? null, q);
    return `<a class="provider-chip provider-chip--link" href="${escapeAttr(url)}" target="_blank" rel="nofollow noopener"><img src="/retailers/${p.logo}.png" alt="" class="provider-icon" loading="lazy" />${escapeHtml(p.label)}</a>`;
  });
  const listenHtml = chips.length
    ? `<div class="section">
         <p class="section-label">Where to listen</p>
         <div class="providers">${chips.join('')}</div>
       </div>`
    : '';

  const body = `
    <div class="detail-hero">
      ${coverImg}
      <h1 class="detail-title">${escapeHtml(show.title)}</h1>
      ${author ? `<p class="detail-subtitle">by ${escapeHtml(author)}</p>` : ''}
    </div>

    ${renderActionRow()}

    ${cleanDesc ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(cleanDesc)}</p>
    </div>` : ''}

    ${listenHtml}
  `;

  const ogImage = await resolveOgImageUrl(cover);

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage,
    ogUrl,
    sharer,
    modalContext,
    body,
  });

  return htmlResponse(html, 86400);
}
