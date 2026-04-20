// Shared HTML template for per-item OG pages.
// Ports renderPage + escape helpers from ~/Tastely/supabase/functions/share/index.ts.

const APP_STORE_ID = '6761599195';

export type PageOptions = {
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogUrl: string;
  body: string;
};

export function renderPage({ ogTitle, ogDescription, ogImage, ogUrl, body }: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(ogTitle)} — Tastely</title>

  <!-- Smart App Banner (iOS Safari) -->
  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}" />

  <!-- Canonical -->
  <link rel="canonical" href="${escapeAttr(ogUrl)}" />

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeAttr(ogTitle)}" />
  <meta property="og:description" content="${escapeAttr(ogDescription)}" />
  ${ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}" />` : ''}
  <meta property="og:image:width" content="500" />
  <meta property="og:image:height" content="750" />
  <meta property="og:url" content="${escapeAttr(ogUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Tastely" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@trytastely" />
  <meta name="twitter:title" content="${escapeAttr(ogTitle)}" />
  <meta name="twitter:description" content="${escapeAttr(ogDescription)}" />
  ${ogImage ? `<meta name="twitter:image" content="${escapeAttr(ogImage)}" />` : ''}

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700&family=Outfit:wght@300;400;500&display=swap" rel="stylesheet" />

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0F0F0F;
      color: #FFFFFF;
      font-family: 'Outfit', -apple-system, sans-serif;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 480px;
      margin: 0 auto;
      padding: 24px 16px 48px;
    }
    .logo {
      font-family: 'Inter', sans-serif;
      font-weight: 700;
      font-size: 20px;
      color: #8b52ee;
      margin-bottom: 24px;
    }

    /* Header */
    .header { margin-bottom: 24px; }
    .tag-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
      color: #8b52ee;
      margin-bottom: 8px;
    }
    h1 {
      font-family: 'Inter', sans-serif;
      font-weight: 700;
      font-size: 24px;
      line-height: 1.2;
      margin-bottom: 6px;
    }
    .subtitle { font-size: 14px; color: #9CA3AF; }
    .description {
      font-size: 14px;
      color: #6B7280;
      margin-top: 8px;
      line-height: 1.5;
    }

    /* Item list (board + user pages) */
    .item-list { display: flex; flex-direction: column; gap: 12px; }
    .item-card {
      display: flex;
      gap: 12px;
      background: #1A1A1A;
      border-radius: 12px;
      padding: 10px;
      border: 1px solid #2D2D2D;
    }
    .poster {
      width: 56px;
      height: 84px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: #252525;
    }
    .poster-placeholder { width: 56px; height: 84px; background: #252525; border-radius: 6px; }
    .item-info { display: flex; flex-direction: column; justify-content: center; }
    .item-title { font-weight: 500; font-size: 15px; margin-bottom: 4px; }
    .item-meta { font-size: 13px; color: #9CA3AF; }

    /* Detail view (movie + book) */
    .detail { margin-bottom: 24px; }
    .detail-header { display: flex; gap: 16px; margin-bottom: 16px; }
    .detail-poster {
      width: 120px;
      height: 180px;
      border-radius: 10px;
      object-fit: cover;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      background: #252525;
    }
    .detail-info {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
    }
    .meta { font-size: 14px; color: #9CA3AF; }
    .rating { font-size: 14px; color: #F59E0B; }
    .genres { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .genre {
      font-size: 12px;
      color: #9CA3AF;
      background: #252525;
      padding: 4px 10px;
      border-radius: 6px;
    }
    .overview { font-size: 15px; color: #9CA3AF; line-height: 1.6; }

    /* Profile */
    .profile-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
    .avatar {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      object-fit: cover;
      background: #252525;
      flex-shrink: 0;
    }
    .profile-info h1 { margin-bottom: 2px; }
    .profile-handle { font-size: 14px; color: #9CA3AF; }
    .profile-bio { font-size: 14px; color: #D1D5DB; line-height: 1.5; margin-bottom: 24px; }

    /* Grid (profile saves) */
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .grid-item {
      aspect-ratio: 2 / 3;
      border-radius: 8px;
      overflow: hidden;
      background: #252525;
    }
    .grid-item img { width: 100%; height: 100%; object-fit: cover; display: block; }

    /* CTA */
    .cta { margin-top: 32px; text-align: center; }
    .cta-text { font-size: 14px; color: #6B7280; margin-bottom: 12px; }
    .cta-button {
      display: inline-block;
      background: #8b52ee;
      color: #FFFFFF;
      font-family: 'Inter', sans-serif;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 32px;
      border-radius: 24px;
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .cta-button:hover { opacity: 0.85; }
    .empty { color: #6B7280; text-align: center; padding: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Tastely</div>
    ${body}
  </div>
</body>
</html>`;
}

export function notFoundPage(message: string, status = 404): Response {
  const html = renderPage({
    ogTitle: 'Tastely',
    ogDescription: 'Discover better recommendations',
    ogImage: '',
    ogUrl: 'https://trytastely.com',
    body: `<div class="empty"><h1>Not Found</h1><p>${escapeHtml(message)}</p></div>
      <div class="cta">
        <a href="https://trytastely.com" class="cta-button">Go to Tastely</a>
      </div>`,
  });
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlResponse(html: string, cacheMaxAge = 86400, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': `public, s-maxage=${cacheMaxAge}, max-age=${Math.min(cacheMaxAge, 3600)}`,
    },
  });
}
