import { escapeHtml, htmlResponse, notFoundPage, renderPage } from '../_lib/template';
import { sbFetchOne, type SupabaseEnv } from '../_lib/supabase';

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
  const ogUrl = new URL(request.url).toString();

  // 1. Try our DB first (cached movies)
  const item = await sbFetchOne<DbMovie>(env, {
    path: `items?external_id=eq.${encodeURIComponent(tmdbId)}&item_type=eq.movie&select=title,description,image_url,external_id,metadata&limit=1`,
    key: 'service',
  });

  if (item) {
    return renderMovie({
      title: item.title,
      description: item.description ?? '',
      posterPath: item.image_url,
      releaseDate: item.metadata?.releaseDate ?? '',
      runtime: item.metadata?.runtime ?? null,
      voteAverage: item.metadata?.voteAverage ?? null,
      director: item.metadata?.director ?? '',
      genres: item.metadata?.genres ?? [],
      ogUrl,
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

    return renderMovie({
      title: m.title,
      description: m.overview ?? '',
      posterPath: m.poster_path,
      releaseDate: m.release_date ?? '',
      runtime: m.runtime ?? null,
      voteAverage: m.vote_average ?? null,
      director: '',
      genres: (m.genres ?? []).map((g) => g.name),
      ogUrl,
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
  voteAverage: number | null;
  director: string;
  genres: string[];
  ogUrl: string;
};

function renderMovie(a: RenderArgs): Response {
  const posterUrl = a.posterPath ? `${TMDB_IMAGE_BASE}/w500${a.posterPath}` : '';
  const year = a.releaseDate ? a.releaseDate.slice(0, 4) : '';
  const runtimeStr = a.runtime ? `${Math.floor(a.runtime / 60)}h ${a.runtime % 60}m` : '';
  const ratingStr = a.voteAverage ? `★ ${a.voteAverage.toFixed(1)}` : '';

  const ogTitle = year ? `${a.title} (${year})` : a.title;
  const ogDescription = a.description
    ? a.description.slice(0, 150) + (a.description.length > 150 ? '...' : '')
    : 'Discover this movie on Tastely';

  const html = renderPage({
    ogTitle,
    ogDescription,
    ogImage: posterUrl,
    ogUrl: a.ogUrl,
    body: `
      <div class="detail">
        <div class="detail-header">
          ${posterUrl ? `<img src="${posterUrl}" alt="${escapeHtml(a.title)}" class="detail-poster" />` : '<div class="detail-poster"></div>'}
          <div class="detail-info">
            <h1>${escapeHtml(a.title)}</h1>
            <p class="meta">${[year, runtimeStr, a.director].filter(Boolean).map(escapeHtml).join(' · ')}</p>
            ${ratingStr ? `<p class="rating">${ratingStr}</p>` : ''}
            ${a.genres.length > 0 ? `<div class="genres">${a.genres.map((g) => `<span class="genre">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
        ${a.description ? `<p class="overview">${escapeHtml(a.description)}</p>` : ''}
      </div>
      <div class="cta">
        <p class="cta-text">Rate, review, and discover on Tastely</p>
        <a href="https://trytastely.com" class="cta-button">Get Tastely</a>
      </div>
    `,
  });

  return htmlResponse(html, 86400);
}
