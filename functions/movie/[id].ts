import { escapeHtml, htmlResponse, notFoundPage, renderActionRow, renderPage, type ModalContext } from '../_lib/template';
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
  release_date: string | null;
  metadata: {
    releaseDate?: string;
    release_date?: string;
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
    path: `items?external_id=eq.${encodeURIComponent(tmdbId)}&item_type=eq.movie&select=title,description,image_url,external_id,release_date,metadata&limit=1`,
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
  // Canonical `release_date` column first — the camelCase metadata.releaseDate
  // is never populated (the data is in the column / snake-case metadata).
  const releaseDate =
    item?.release_date ?? item?.metadata?.release_date ?? item?.metadata?.releaseDate ?? tmdb?.release_date ?? '';
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

  // Director gets its own subtitle line ("Directed by …") — mirrors the album's
  // "by {artist}" and disambiguates the person (a bare name reads as an actor).
  // The meta line below carries the factual chips: year · runtime · genres.
  const genreSegment = a.genres.slice(0, 2).filter(Boolean).join(' / ');
  const metaParts = [year, runtimeStr, genreSegment].filter(Boolean);
  const metaLine = metaParts.length
    ? metaParts.map((s) => escapeHtml(s)).join(' <span class="dot">·</span> ')
    : '';
  const subtitle = a.director ? `Directed by ${escapeHtml(a.director)}` : '';

  const watchHtml = renderWatchSection(a.watchProviders);

  const body = `
    <div class="detail-hero">
      ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(a.title)}" class="detail-cover" />` : '<div class="detail-cover"></div>'}
      <h1 class="detail-title">${escapeHtml(a.title)}</h1>
      ${subtitle ? `<p class="detail-subtitle">${subtitle}</p>` : ''}
      ${metaLine ? `<p class="detail-meta">${metaLine}</p>` : ''}
    </div>

    ${renderActionRow()}

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
