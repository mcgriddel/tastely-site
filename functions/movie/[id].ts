import { escapeHtml, htmlResponse, notFoundPage, renderPage, type ModalContext } from '../_lib/template';
import { sbFetchOne, type SupabaseEnv } from '../_lib/supabase';
import { lookupSharer } from '../_lib/sharer';

type Env = SupabaseEnv & { TMDB_API_KEY?: string };

type DbMovie = {
  title: string;
  description: string | null;
  image_url: string | null;
  external_id: string;
  metadata: {
    releaseDate?: string;
    runtime?: number;
    voteAverage?: number;
    director?: string;
    genres?: string[];
  } | null;
};

type TmdbMovie = {
  title: string;
  overview: string;
  poster_path: string | null;
  release_date: string;
  runtime: number | null;
  vote_average: number;
  genres: { name: string }[];
};

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const tmdbId = String(params.id);
  const url = new URL(request.url);
  const ogUrl = url.toString();
  const fromUserId = url.searchParams.get('from');

  // Sharer attribution lookup runs in parallel with item lookup.
  const sharerPromise = lookupSharer(env, fromUserId);

  // 1. Try our DB first (cached movies)
  const item = await sbFetchOne<DbMovie>(env, {
    path: `items?external_id=eq.${encodeURIComponent(tmdbId)}&item_type=eq.movie&select=title,description,image_url,external_id,metadata&limit=1`,
    key: 'service',
  });

  if (item) {
    const sharer = await sharerPromise;
    return renderMovie({
      title: item.title,
      description: item.description ?? '',
      posterPath: item.image_url,
      releaseDate: item.metadata?.releaseDate ?? '',
      runtime: item.metadata?.runtime ?? null,
      director: item.metadata?.director ?? '',
      genres: item.metadata?.genres ?? [],
      tmdbId: item.external_id,
      ogUrl,
      sharer,
    });
  }

  // 2. Fall back to TMDB
  if (!env.TMDB_API_KEY) return notFoundPage('Movie not found');

  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${env.TMDB_API_KEY}&language=en-US`,
    );
    if (!res.ok) return notFoundPage('Movie not found');
    const m = (await res.json()) as TmdbMovie;
    const sharer = await sharerPromise;

    return renderMovie({
      title: m.title,
      description: m.overview ?? '',
      posterPath: m.poster_path,
      releaseDate: m.release_date ?? '',
      runtime: m.runtime ?? null,
      director: '',
      genres: (m.genres ?? []).map((g) => g.name),
      tmdbId,
      ogUrl,
      sharer,
    });
  } catch {
    return notFoundPage('Movie not found');
  }
};

type RenderArgs = {
  title: string;
  description: string;
  posterPath: string | null;
  releaseDate: string;
  runtime: number | null;
  director: string;
  genres: string[];
  tmdbId: string;
  ogUrl: string;
  sharer: Awaited<ReturnType<typeof lookupSharer>>;
};

function renderMovie(a: RenderArgs): Response {
  const posterUrl = a.posterPath
    ? a.posterPath.startsWith('http')
      ? a.posterPath.replace(/\/t\/p\/w\d+\//, '/t/p/w500/')
      : `${TMDB_IMAGE_BASE}/w500${a.posterPath}`
    : '';
  const year = a.releaseDate ? a.releaseDate.slice(0, 4) : '';
  const runtimeStr = a.runtime ? `${Math.floor(a.runtime / 60)}h ${a.runtime % 60}m` : '';

  const ogTitle = year ? `${a.title} (${year})` : a.title;
  const ogDescription = a.description
    ? a.description.slice(0, 150) + (a.description.length > 150 ? '…' : '')
    : 'Discover this movie on Tastely';

  const modalContext: ModalContext = {
    itemTitle: a.title,
    itemType: 'movie',
    externalId: a.tmdbId,
    externalSource: 'tmdb',
    saveCtaLabel: `Save ${a.title} to your watchlist`,
  };

  const metaParts = [year, runtimeStr, a.director].filter(Boolean);
  const metaLine = metaParts.length
    ? metaParts.map((s) => escapeHtml(s)).join(' <span class="dot">·</span> ')
    : '';

  const genresHtml = a.genres.length
    ? `<div class="section">
         <p class="section-label">Genres</p>
         <div class="providers">
           ${a.genres
             .slice(0, 6)
             .map((g) => `<span class="provider-chip">${escapeHtml(g)}</span>`)
             .join('')}
         </div>
       </div>`
    : '';

  const body = `
    <div class="detail-hero">
      ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(a.title)}" class="detail-cover" />` : '<div class="detail-cover"></div>'}
      <h1 class="detail-title">${escapeHtml(a.title)}</h1>
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

    ${a.description ? `
    <div class="section">
      <p class="section-label">About</p>
      <p class="section-prose">${escapeHtml(a.description)}</p>
    </div>` : ''}

    ${genresHtml}
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
