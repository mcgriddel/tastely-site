import { escapeAttr, escapeHtml, htmlResponse, notFoundPage, renderPage, type ModalContext } from '../_lib/template';
import { sbFetch, sbFetchOne, type SupabaseEnv } from '../_lib/supabase';
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
    'as','at','by','for','from','in','of','off','on','onto','to','up','via','with',
    'is','it',
  ]);
  return s.toLowerCase().split(/\s+/).map((word, i, arr) => {
    if (i > 0 && i < arr.length - 1 && minor.has(word)) return word;
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

    return renderBook({
      title: properCaseTitle(item.title),
      authors,
      description: item.description ?? '',
      cover,
      fallbackCover: nytCover || fromChain || openLibraryCover(isbn),
      publishedDate: item.metadata?.publishedDate ?? '',
      categories: item.metadata?.categories ?? [],
      pageCount: item.metadata?.pageCount ?? null,
      publisher: item.metadata?.publisher ?? '',
      buyLinks: item.metadata?.buy_links ?? [],
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
      return renderBook({
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
        buyLinks: dbRow.metadata?.buy_links ?? [],
        externalId: dbRow.external_id,
        externalSource: dbRow.external_source ?? 'unknown',
        ogUrl,
        sharer,
      });
    }

    // Pure GB render (no DB row found by either path)
    const cover = pickBestCover(info.imageLinks) || openLibraryCover(isbn);
    const sharer = await sharerPromise;

    return renderBook({
      title: properCaseTitle(info.title),
      authors: info.authors ?? [],
      description: info.description ?? '',
      cover,
      fallbackCover: openLibraryCover(isbn),
      publishedDate: info.publishedDate ?? '',
      categories: info.categories ?? [],
      pageCount: info.pageCount ?? null,
      publisher: info.publisher ?? '',
      buyLinks: [],
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
          title: properCaseTitle(ol.title || 'Unknown title'),
          authors: [],
          description: ol.description?.value || ol.description || '',
          cover: openLibraryCover(volumeId),
          fallbackCover: '',
          publishedDate: ol.publish_date || '',
          categories: [],
          pageCount: ol.number_of_pages ?? null,
          publisher: (ol.publishers && ol.publishers[0]) || '',
          buyLinks: [],
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
  buyLinks: Array<{ name: string; url: string }>;
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

function renderBook(a: RenderArgs): Response {
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

  // S140 — retailer logos sourced from Brandfetch CDN (real brand assets).
  // URLs pre-fetched once via Brand API + hardcoded so the function does
  // zero runtime API calls (stays under free-tier limits permanently and
  // resilient to Brandfetch availability). The embedded `c=` token in
  // each URL is Brandfetch's per-brand CDN auth, designed for hotlinking.
  //
  // shape: 'icon' = square symbol/icon (combines well with brand-name text)
  //        'wordmark' = full brand wordmark (renders alone, no text — the
  //         wordmark IS the brand identity, text would be redundant)
  // Refresh by re-running the Brand API lookup if a logo ever 404s.
  // Map keys = lowercase NYT retailer names.
  // `inset: true` adds internal padding for full-bleed marks that would
  // otherwise clip into the rounded-square edges (e.g. B&N's local PNG).
  type RetailerLogo = { url: string; shape: 'icon' | 'wordmark'; inset?: boolean };
  const RETAILER_LOGO: Record<string, RetailerLogo> = {
    'amazon':           { url: 'https://cdn.brandfetch.io/idawOgYOsG/theme/dark/symbol.svg?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'icon' },
    'apple books':      { url: 'https://cdn.brandfetch.io/idnrCPuv87/w/400/h/400/theme/dark/icon.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'icon' },
    'apple':            { url: 'https://cdn.brandfetch.io/idnrCPuv87/w/400/h/400/theme/dark/icon.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'icon' },
    'barnes & noble':   { url: '/retailers/barnesandnoble.png', shape: 'icon', inset: true },
    'books-a-million':  { url: 'https://cdn.brandfetch.io/idpqzOZXsi/w/400/h/400/theme/dark/icon.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'icon' },
    'bookshop.org':     { url: 'https://cdn.brandfetch.io/ideqM0dIIo/w/396/h/104/theme/dark/logo.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'wordmark' },
    'bookshop':         { url: 'https://cdn.brandfetch.io/ideqM0dIIo/w/396/h/104/theme/dark/logo.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'wordmark' },
    'audible':          { url: 'https://cdn.brandfetch.io/idT82q9yNb/w/400/h/400/theme/dark/icon.png?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'icon' },
    'kobo':             { url: 'https://cdn.brandfetch.io/id3tDnj0HA/theme/dark/logo.svg?c=1bxzxbvnwju0xdrqkbt3cqp2ha89ksp2yLT', shape: 'wordmark' },
  };

  function logoFor(name: string): RetailerLogo | null {
    const key = name.toLowerCase().trim();
    if (RETAILER_LOGO[key]) return RETAILER_LOGO[key];
    for (const k of Object.keys(RETAILER_LOGO)) {
      if (key.includes(k) || k.includes(key)) return RETAILER_LOGO[k];
    }
    return null;
  }

  // Retailers to suppress from the where-to-buy strip. Lowercased name
  // match. Add to this set to hide a retailer without removing the data
  // from the upstream NYT substrate.
  const BUY_LINK_BLOCKLIST = new Set(['bookshop.org', 'bookshop']);
  const visibleBuyLinks = a.buyLinks.filter(
    (b) => !BUY_LINK_BLOCKLIST.has(b.name.toLowerCase().trim()),
  );

  const buyLinksHtml = visibleBuyLinks.length
    ? `<div class="section">
         <p class="section-label">Where to buy</p>
         <div class="providers">
           ${visibleBuyLinks
             .map((b) => {
               const logo = logoFor(b.name);
               if (!logo) {
                 // unknown retailer → text-only chip (safe fallback)
                 return `<a class="provider-chip provider-chip--link" href="${escapeAttr(b.url)}" target="_blank" rel="nofollow noopener">${escapeHtml(b.name)}</a>`;
               }
               if (logo.shape === 'wordmark') {
                 // wordmark IS the brand — render alone, no text alongside
                 return `<a class="provider-chip provider-chip--link provider-chip--wordmark" href="${escapeAttr(b.url)}" target="_blank" rel="nofollow noopener" aria-label="Buy on ${escapeAttr(b.name)}"><img src="${escapeAttr(logo.url)}" alt="${escapeAttr(b.name)}" class="provider-wordmark" loading="lazy" /></a>`;
               }
               // icon shape — combines with brand-name text
               const iconClass = logo.inset ? 'provider-icon provider-icon--inset' : 'provider-icon';
               return `<a class="provider-chip provider-chip--link" href="${escapeAttr(b.url)}" target="_blank" rel="nofollow noopener"><img src="${escapeAttr(logo.url)}" alt="" class="${iconClass}" loading="lazy" />${escapeHtml(b.name)}</a>`;
             })
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

    <div class="actions">
      <button class="pill" type="button" data-share-action="save">
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 5C5 3.9 5.9 3 7 3H17C18.1 3 19 3.9 19 5V21L12 17.5L5 21V5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Save
      </button>
      <button class="pill" type="button" data-share-action="board">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8V16M8 12H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
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

    ${buyLinksHtml}

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
