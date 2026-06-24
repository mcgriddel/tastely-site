// Shared "Where to watch" logic for movie + TV share pages. TMDB's watch-
// provider data (JustWatch-sourced) is region-keyed and identical in shape for
// movies and TV — only the endpoint path differs (`/movie/...` vs `/tv/...`) —
// so both routes resolve + render through here to stay in lockstep. Mirrors the
// in-app `WatchProviderBadge` (the movie + TV detail screens share it too).

import { escapeHtml } from './template';
import type { SupabaseEnv } from './supabase';

export type WatchEnv = SupabaseEnv & { TMDB_API_KEY?: string };

export type MediaType = 'movie' | 'tv';

// Shape of the cached providers we persist on `items.metadata.watch_providers`
// (region → list). Movies have this populated at ingest; TV currently doesn't,
// so TV falls through to the live fetch below.
export type CachedWatchProvider = {
  logoPath?: string;
  providerName?: string;
  providerId?: number;
};
export type CachedWatchProvidersByRegion = Record<
  string,
  {
    flatrate?: CachedWatchProvider[];
    rent?: CachedWatchProvider[];
    buy?: CachedWatchProvider[];
    fetched_at?: string;
  }
>;

type TmdbWatchProvider = { logo_path: string; provider_name: string; provider_id: number };
type WatchProvidersForRegion = {
  link: string;
  flatrate?: TmdbWatchProvider[];
  rent?: TmdbWatchProvider[];
  buy?: TmdbWatchProvider[];
};
type TmdbWatchProvidersResponse = { results: Record<string, WatchProvidersForRegion | undefined> };

export type ResolvedProvider = { logoUrl: string; providerName: string };
export type WatchProvidersOut = { providers: ResolvedProvider[]; tmdbLink: string } | null;

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Pick the most actionable list — flatrate (subscription) wins, then rent, then
// buy. A title not on any streaming service still surfaces its rent/buy options
// rather than rendering an empty section.
function pickProviderList<T>(region: { flatrate?: T[]; rent?: T[]; buy?: T[] } | undefined): T[] {
  if (!region) return [];
  if (region.flatrate?.length) return region.flatrate;
  if (region.rent?.length) return region.rent;
  if (region.buy?.length) return region.buy;
  return [];
}

function logoUrlFromPath(path?: string): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `${TMDB_IMAGE_BASE}/w92${path}`;
}

// First preference — read from the cached metadata.watch_providers if the items
// row already has it (saves a TMDB API call AND captures rent/buy shapes the
// live-fetch flatrate filter discards).
function watchProvidersFromCache(
  cache: CachedWatchProvidersByRegion | undefined,
  country: string,
  tmdbId: string,
  mediaType: MediaType,
): WatchProvidersOut {
  if (!cache) return null;
  const region = cache[country] ?? cache.US;
  if (!region) return null;
  const list = pickProviderList(region);
  if (!list.length) return null;
  const providers: ResolvedProvider[] = [];
  for (const p of list) {
    const logoUrl = logoUrlFromPath(p.logoPath);
    if (!logoUrl || !p.providerName) continue;
    providers.push({ logoUrl, providerName: p.providerName });
  }
  if (!providers.length) return null;
  return {
    providers,
    tmdbLink: `https://www.themoviedb.org/${mediaType}/${tmdbId}/watch?locale=${country}`,
  };
}

async function fetchWatchProviders(
  tmdbId: string,
  apiKey: string | undefined,
  country: string,
  mediaType: MediaType,
): Promise<WatchProvidersOut> {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(tmdbId)}/watch/providers?api_key=${apiKey}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as TmdbWatchProvidersResponse;
    const region = j.results[country] ?? j.results.US;
    if (!region) return null;
    const list = pickProviderList(region);
    if (!list.length) return null;
    const providers: ResolvedProvider[] = list.map((p) => ({
      logoUrl: logoUrlFromPath(p.logo_path) ?? '',
      providerName: p.provider_name,
    }));
    return { providers: providers.filter((p) => p.logoUrl), tmdbLink: region.link };
  } catch {
    return null;
  }
}

// Cache-first, then live TMDB fetch. The single entry point both routes call.
export async function resolveWatchProviders(opts: {
  cache: CachedWatchProvidersByRegion | undefined;
  country: string;
  tmdbId: string;
  apiKey: string | undefined;
  mediaType: MediaType;
}): Promise<WatchProvidersOut> {
  const cached = watchProvidersFromCache(opts.cache, opts.country, opts.tmdbId, opts.mediaType);
  if (cached) return cached;
  return fetchWatchProviders(opts.tmdbId, opts.apiKey, opts.country, opts.mediaType);
}

// The "Where to watch" section markup — identical for movie + TV. Self-hides
// when there are no providers so the section label never orphans.
export function renderWatchSection(out: WatchProvidersOut): string {
  if (!out || !out.providers.length) return '';
  return `<div class="section">
         <p class="section-label">Where to watch</p>
         <div class="providers">
           ${out.providers
             .slice(0, 8)
             .map(
               (p) => `<a class="provider-chip provider-chip--link" href="${escapeHtml(out.tmdbLink)}" target="_blank" rel="noopener">
                 <img class="provider-icon" src="${escapeHtml(p.logoUrl)}" alt="${escapeHtml(p.providerName)}" loading="lazy" />
                 <span class="provider-name">${escapeHtml(p.providerName)}</span>
               </a>`,
             )
             .join('')}
         </div>
       </div>`;
}
