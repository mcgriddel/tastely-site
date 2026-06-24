import { escapeHtml, htmlResponse, notFoundPage, renderPage, type ModalContext } from '../_lib/template';
import { sbFetchOne, type SupabaseEnv } from '../_lib/supabase';
import { lookupSharer } from '../_lib/sharer';
import {
  resolveWatchProviders,
  renderWatchSection,
  type CachedWatchProvidersByRegion,
  type WatchProvidersOut,
} from '../_lib/watchProviders';

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
    watch_providers?: CachedWatchProvidersByRegion;
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

async function fetchTmdbMovie(tmdbId: string, apiKey: string): Promise<TmdbMovie | null> {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${apiKey}&language=en-US`,
    );
    if (!res.ok) return null;
    return (await res.json()) as TmdbMovie;
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const tmdbId = String(params.id);
  const url = new URL(request.url);
  const ogUrl = url.toString();
  const fromUserId = url.searchParams.get('from');
  // CF edges set `request.cf.country` to the viewer's 2-letter ISO code.
  // Cached HTML responses are keyed by URL only — first viewer at an edge
  // determines that edge's cached country. Acceptable v1; revisit by
  // splitting cache via Vary or per-region paths if it becomes an issue.
  const country = (request as unknown as { cf?: { country?: string } }).cf?.country ?? 'US';

  const sharerPromise = lookupSharer(env, fromUserId);

  // 1. Try our DB first (cached movies)
  const item = await sbFetchOne<DbMovie>(env, {
    path: `items?external_id=eq.${encodeURIComponent(tmdbId)}&item_type=eq.movie&select=title,description,image_url,external_id,metadata&limit=1`,
    key: 'service',
  });

  // Detect a sparse DB row — substrate ingest paths sometimes write
  // {title, poster, release_date} only, leaving description null + genres
  // empty. Render-time fallback fetches TMDB to fill the gaps so the
  // share-landing page is never bare. (Backlog item — fix at ingest.)
  const dbIsSparse = !!item && (!item.description || (item.metadata?.genres?.length ?? 0) === 0);
  const needsTmdb = !item || dbIsSparse;

  const tmdbPromise = needsTmdb && env.TMDB_API_KEY
    ? fetchTmdbMovie(tmdbId, env.TMDB_API_KEY)
    : Promise.resolve(null);

  // Watch providers: cache-first (captures rent/buy shapes the live flatrate-only
  // filter discards), else a fresh TMDB fetch. Shared with the TV share route.
  const watchProvidersPromise: Promise<WatchProvidersOut> = resolveWatchProviders({
    cache: item?.metadata?.watch_providers,
    country,
    tmdbId,
    apiKey: env.TMDB_API_KEY,
    mediaType: 'movie',
  });

  const [sharer, tmdb, watchProviders] = await Promise.all([
    sharerPromise,
    tmdbPromise,
    watchProvidersPromise,
  ]);

  if (!item && !tmdb) return notFoundPage('Movie not found');

  // Merge: prefer DB values when present, fill gaps from TMDB.
  const title = item?.title ?? tmdb?.title ?? '';
  const description = item?.description ?? tmdb?.overview ?? '';
  const posterPath = item?.image_url ?? tmdb?.poster_path ?? null;
  const releaseDate = item?.metadata?.releaseDate ?? tmdb?.release_date ?? '';
  const runtime = item?.metadata?.runtime ?? tmdb?.runtime ?? null;
  const director = item?.metadata?.director ?? '';
  const dbGenres = item?.metadata?.genres ?? [];
  const genres = dbGenres.length > 0
    ? dbGenres
    : (tmdb?.genres ?? []).map((g) => g.name);

  return renderMovie({
    title,
    description,
    posterPath,
    releaseDate,
    runtime,
    director,
    genres,
    tmdbId: item?.external_id ?? tmdbId,
    ogUrl,
    sharer,
    watchProviders,
  });
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
  watchProviders: WatchProvidersOut;
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

  // Year/runtime/director are sequential metadata (dot-separated).
  // Genres are peer categories — joined by slash, then folded as one
  // segment onto the dot-separated meta line.
  const genreSegment = a.genres.slice(0, 2).filter(Boolean).join(' / ');
  const metaParts = [year, runtimeStr, a.director, genreSegment].filter(Boolean);
  const metaLine = metaParts.length
    ? metaParts.map((s) => escapeHtml(s)).join(' <span class="dot">·</span> ')
    : '';

  const watchHtml = renderWatchSection(a.watchProviders);

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

    ${watchHtml}
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
