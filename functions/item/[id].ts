import { escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
import { sbFetchOne, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type DbBook = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  metadata: {
    authors?: string[];
    isbn?: string;
    isbn_13?: string;
    publishedDate?: string;
    categories?: string[];
    averageRating?: number;
    pageCount?: number;
    // S139 — multi-source cover registry written by the resolver at ingest.
    // Each entry: { url, source, priority, license, attribution, verified_at }.
    // The Cloudflare function chains through these for the og:image to handle
    // URL rot between ingest time + share-preview render time.
    image_sources?: Array<{ url: string; source: string; priority: number }>;
  } | null;
};

type GoogleBook = {
  volumeInfo: {
    title: string;
    authors?: string[];
    description?: string;
    publishedDate?: string;
    categories?: string[];
    averageRating?: number;
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
  // Upgrade to https and strip edge=curl
  return url.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
}

function openLibraryCover(isbn?: string): string {
  if (!isbn) return '';
  const clean = isbn.replace(/[^0-9Xx]/g, '');
  // S139 — strict mode `?default=false` so OL returns 404 (instead of a 1×1
  // GIF placeholder) for ISBNs without a cover. Lets receiving share clients
  // (iMessage / Twitter / etc.) fall through to no-image rather than render
  // a phantom blank tile.
  return clean ? `https://covers.openlibrary.org/b/isbn/${clean}-L.jpg?default=false` : '';
}

// S139 — pick the first working cover URL out of the resolver's persisted
// chain. This is the server-side mirror of the client's SmartCover ladder:
// when ingest captured multiple candidate URLs, the share-preview server
// can pick one that's still valid even if the canonical `image_url` rotted.
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

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const volumeId = String(params.id);
  const ogUrl = new URL(request.url).toString();

  // 1. DB first
  const item = await sbFetchOne<DbBook>(env, {
    path: `items?external_id=eq.${encodeURIComponent(volumeId)}&item_type=eq.book&select=title,description,image_url,external_id,metadata&limit=1`,
    key: 'service',
  });

  if (item) {
    const authors = item.metadata?.authors ?? [];
    // S139 — extended cover resolution chain: items.image_url →
    // metadata.image_sources[] (resolver-persisted candidates) → OL by ISBN
    // → empty (no og:image, receiver renders no preview rather than phantom).
    const isbn = item.metadata?.isbn ?? item.metadata?.isbn_13;
    const fromChain = pickFromImageSources(item.metadata?.image_sources);
    const cover = item.image_url || fromChain || openLibraryCover(isbn);
    return renderBook({
      title: item.title,
      authors,
      description: item.description ?? '',
      cover,
      fallbackCover: fromChain || openLibraryCover(isbn),
      publishedDate: item.metadata?.publishedDate ?? '',
      categories: item.metadata?.categories ?? [],
      averageRating: item.metadata?.averageRating ?? null,
      pageCount: item.metadata?.pageCount ?? null,
      ogUrl,
    });
  }

  // 2. Fall back to Google Books
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(volumeId)}`);
    if (!res.ok) return notFoundPage('Book not found');
    const gb = (await res.json()) as GoogleBook;
    const info = gb.volumeInfo;
    const isbn = pickIsbn(info.industryIdentifiers);
    const cover = pickBestCover(info.imageLinks) || openLibraryCover(isbn);

    return renderBook({
      title: info.title,
      authors: info.authors ?? [],
      description: info.description ?? '',
      cover,
      fallbackCover: openLibraryCover(isbn),
      publishedDate: info.publishedDate ?? '',
      categories: info.categories ?? [],
      averageRating: info.averageRating ?? null,
      pageCount: info.pageCount ?? null,
      ogUrl,
    });
  } catch {
    return notFoundPage('Book not found');
  }
};

type RenderArgs = {
  title: string;
  authors: string[];
  description: string;
  cover: string;
  fallbackCover: string;
  publishedDate: string;
  categories: string[];
  averageRating: number | null;
  pageCount: number | null;
  ogUrl: string;
};

function renderBook(a: RenderArgs): Response {
  const year = a.publishedDate ? a.publishedDate.slice(0, 4) : '';
  const authorStr = a.authors[0] ?? '';
  const pagesStr = a.pageCount ? `${a.pageCount} pages` : '';
  const ratingStr = a.averageRating ? `★ ${a.averageRating.toFixed(1)}` : '';

  const ogTitleBase = authorStr ? `${a.title} by ${authorStr}` : a.title;
  const ogTitle = ogTitleBase;
  const ogDescription = a.description
    ? a.description.replace(/<[^>]+>/g, '').slice(0, 150) + (a.description.length > 150 ? '...' : '')
    : 'Discover this book on Tastely';

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage: a.cover || a.fallbackCover,
    ogUrl: a.ogUrl,
    body: `
      <div class="detail">
        <div class="detail-header">
          ${a.cover ? `<img src="${a.cover}" alt="${escapeHtml(a.title)}" class="detail-poster" ${a.fallbackCover ? `onerror="this.onerror=null;this.src='${a.fallbackCover}'"` : ''} />` : '<div class="detail-poster"></div>'}
          <div class="detail-info">
            <h1>${escapeHtml(a.title)}</h1>
            ${authorStr ? `<p class="meta">by ${escapeHtml(a.authors.join(', '))}</p>` : ''}
            <p class="meta">${[year, pagesStr].filter(Boolean).map(escapeHtml).join(' · ')}</p>
            ${ratingStr ? `<p class="rating">${ratingStr}</p>` : ''}
            ${a.categories.length > 0 ? `<div class="genres">${a.categories.slice(0, 3).map((c) => `<span class="genre">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
        ${a.description ? `<p class="overview">${escapeHtml(a.description.replace(/<[^>]+>/g, ''))}</p>` : ''}
      </div>
      <div class="cta">
        <p class="cta-text">Track what you're reading on Tastely</p>
        <a href="https://trytastely.com" class="cta-button">Get Tastely</a>
      </div>
    `,
  });

  return htmlResponse(html, 86400);
}
