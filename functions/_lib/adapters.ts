// Adapter contract for share-landing pages.
//
// Each share type (movie, book, person, author, tv-series, book-series) ships
// an adapter module declaring how its hero / metadata / body / providers / OG
// meta render. The shared template (`template.ts`) composes them with the
// universal chrome (wordmark, sharer row, action pills, sticky bar, modal,
// footer). Adding a new vertical = write one adapter + one route file. Plan
// in `~/Tastely/.claude/plans/share-landing-customer-acquisition.md` §3.

export type ShareType =
  | 'movie'
  | 'book'
  | 'person'
  | 'author'
  | 'tv_series'
  | 'book_series'
  | 'board'
  | 'user';

export type AdapterRender = {
  // OG / Smart App Banner / SEO meta
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogImageWidth?: number;
  ogImageHeight?: number;

  // Visual slots (HTML strings). Adapter is responsible for escaping its own
  // user-controlled content via `escapeHtml` from template.ts.
  hero: string;
  metadataStrip: string;
  body: string;             // description + cast/author + similar — full-fat content
  providerStrip?: string;   // optional — where to watch / buy / listen

  // Modal context — driven into `window.__SHARE_CONTEXT__` so action-tap
  // handlers can render the right contextual copy ("Save X to your library").
  modalContext: {
    itemTitle: string;
    itemType: ShareType;
    externalId: string;
    externalSource: string;
    saveCtaLabel: string;   // e.g. "Save Theo of Golden to your library"
  };
};

export type AdapterFetcher<T> = {
  // Try to find the item in our DB or external source. Returns null if all
  // resolution paths fail — the route handler then renders `notFoundPage`.
  fetch: (id: string, env: any, query?: URLSearchParams) => Promise<T | null>;
  // Render the resolved data into the slots above.
  render: (data: T, ctx: { ogUrl: string }) => AdapterRender;
};
