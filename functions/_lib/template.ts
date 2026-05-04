// Shared HTML template for share-landing pages.
//
// Composes the universal chrome (wordmark, sharer row, trust footer, sticky
// bar, signup modal) around per-vertical adapter slots (hero, metadata,
// body, providers). See `adapters.ts` for the slot contract and the plan
// in `~/Tastely/.claude/plans/share-landing-customer-acquisition.md` for
// the design rationale.
//
// Aesthetic direction (S140): "warm digital editorial" —
//   - Dark `#0F0F0F` base + film-grain SVG overlay
//   - Brand fonts: Inter 700/800 for display (tight tracking on titles),
//     Outfit 300/400/500 for body
//   - Brand gradient (purple → pink → blue) used as accent only — never
//     flooding the page (per Apple's neutral-substrate lesson + competitive
//     scan finding that brand-flooded pages read as marketing, not product)
//   - Per-item glow halo behind the cover for premium feel
//   - Sharer-attribution row above the hero — Tastely's untapped
//     differentiator (no surveyed competitor surfaces the sender)
//
// CSS + JS inlined so the page is one HTTP request. Deliberately no
// external bundler — Cloudflare Pages Functions runtime keeps it simple.

import type { SharerProfile } from './sharer';

const APP_STORE_ID = '6761599195';
const ANALYTICS_ENDPOINT = '/api/log-share-event';

export type ModalContext = {
  itemTitle: string;
  itemType: string;
  externalId: string;
  externalSource: string;
  saveCtaLabel: string;
};

export type PageOptions = {
  // OG / SEO
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  ogUrl: string;

  // Adapter-rendered body (everything between sharer row and footer).
  // Routes without per-vertical adapters (user, board) pass their own.
  body: string;

  // Sharer attribution row (skipped if undefined).
  sharer?: SharerProfile | null;

  // Modal + sticky bar context — required for item-share pages where
  // action pills can fire signup. Omit for pages that don't have action
  // pills (raw board view, raw profile view).
  modalContext?: ModalContext;

  // Hero glow tint — RGB string for the halo behind the cover. Defaults
  // to brand purple if not provided. Adapters can pull a color from the
  // cover art for per-item character (Apple Music pattern).
  heroGlowRgb?: string;
};

export function renderPage(opts: PageOptions): string {
  const {
    ogTitle,
    ogDescription,
    ogImage,
    ogImageWidth = 500,
    ogImageHeight = 750,
    ogUrl,
    body,
    sharer,
    modalContext,
    heroGlowRgb = '139, 82, 238',
  } = opts;

  const sharerRow = sharer ? renderSharerRow(sharer) : '';
  const stickyBar = modalContext ? renderStickyBar() : '';
  const modal = modalContext ? renderSignupModal() : '';
  const modalScript = modalContext ? renderModalScript(modalContext) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(ogTitle)} — Tastely</title>

  <!-- Smart App Banner (iOS Safari) — handles "open in app if installed" -->
  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}" />

  <!-- Canonical -->
  <link rel="canonical" href="${escapeAttr(ogUrl)}" />

  <!-- Open Graph -->
  <meta property="og:title" content="${escapeAttr(ogTitle)}" />
  <meta property="og:description" content="${escapeAttr(ogDescription)}" />
  ${ogImage ? `<meta property="og:image" content="${escapeAttr(ogImage)}" />` : ''}
  <meta property="og:image:width" content="${ogImageWidth}" />
  <meta property="og:image:height" content="${ogImageHeight}" />
  <meta property="og:url" content="${escapeAttr(ogUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Tastely" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@trytastely" />
  <meta name="twitter:title" content="${escapeAttr(ogTitle)}" />
  <meta name="twitter:description" content="${escapeAttr(ogDescription)}" />
  ${ogImage ? `<meta name="twitter:image" content="${escapeAttr(ogImage)}" />` : ''}

  <!-- Theme color for mobile chrome -->
  <meta name="theme-color" content="#0F0F0F" />

  <!-- Brand fonts: Inter (display) + Outfit (body). Brand-locked. -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet" />

  ${BASE_STYLES}
  ${heroGlowStyle(heroGlowRgb)}
</head>
<body>
  <!-- Film-grain overlay — subtle SVG noise for warmth -->
  <div class="grain" aria-hidden="true"></div>

  <!-- Header chrome -->
  <header class="chrome" role="banner">
    <a href="/" class="chrome-logo" aria-label="Tastely home">
      <img src="/wordmark.png" alt="Tastely" width="92" height="22" />
    </a>
    <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="chrome-signin">Sign in</a>
  </header>

  <!-- Hero glow halo (per-item color, soft) -->
  <div class="hero-glow" aria-hidden="true"></div>

  <main class="container">
    ${sharerRow}
    ${body}
    ${renderTrustFooter()}
  </main>

  ${stickyBar}
  ${modal}

  ${modalScript}
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Chrome fragments
// ─────────────────────────────────────────────────────────────────────────

function renderSharerRow(p: SharerProfile): string {
  const name = p.display_name || (p.username ? `@${p.username}` : 'A friend');
  const initial = (p.display_name || p.username || '?').charAt(0).toUpperCase();
  const avatar = p.avatar_url
    ? `<img src="${escapeAttr(p.avatar_url)}" alt="" />`
    : `<span class="sharer-avatar-fallback">${escapeHtml(initial)}</span>`;
  return `
    <a class="sharer" href="/user/${escapeAttr(p.id)}" data-share-event="sharer_tapped">
      <span class="sharer-avatar">${avatar}</span>
      <span class="sharer-text">
        <span class="sharer-name">${escapeHtml(name)}</span>
        <span class="sharer-suffix">sent you this</span>
      </span>
      <span class="sharer-arrow" aria-hidden="true">→</span>
    </a>`;
}

function renderTrustFooter(): string {
  return `
    <footer class="trust-footer">
      <p class="trust-copyright">© 2026 Tastely</p>
    </footer>`;
}

function renderStickyBar(): string {
  return `
    <div class="sticky-bar" role="complementary">
      <span class="sticky-bar-text">Track what you love on Tastely</span>
      <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="sticky-bar-cta" data-share-event="sticky_bar_tapped">Get the app</a>
    </div>`;
}

function renderSignupModal(): string {
  return `
    <div class="modal-backdrop" id="signup-modal" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <button class="modal-close" id="modal-close" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>

        <!-- Default state: signup options -->
        <div class="modal-state" data-state="signup">
          <div class="modal-icon-ring" aria-hidden="true">
            <div class="modal-icon-inner">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L14.4 9.4L22 9.4L15.8 14L18.2 21.4L12 16.8L5.8 21.4L8.2 14L2 9.4L9.6 9.4L12 2Z" stroke="white" stroke-width="1.5" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
          <h2 class="modal-title" id="modal-title">Save this to your library</h2>
          <p class="modal-subtitle">Tastely keeps the things you love organized — and recommends what's next.</p>

          <div class="modal-actions">
            <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="modal-btn modal-btn-oauth" data-share-event="modal_continue_in_app">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
              </svg>
              Continue in the Tastely app
            </a>
            <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="modal-btn modal-btn-oauth" data-share-event="modal_continue_in_app">
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </a>
          </div>

          <div class="modal-divider"><span>or save your spot</span></div>

          <form class="modal-form" id="email-form">
            <input
              type="email"
              name="email"
              id="email-input"
              placeholder="your@email.com"
              required
              autocomplete="email"
              inputmode="email"
            />
            <button type="submit" class="modal-btn modal-btn-primary" id="email-submit">
              <span class="modal-btn-label">Save my spot</span>
              <span class="modal-btn-spinner" aria-hidden="true"></span>
            </button>
          </form>

          <p class="modal-fineprint">We'll email you a quick note with the app link. No password to remember — set one up inside the app.</p>
        </div>

        <!-- Success state: new user captured -->
        <div class="modal-state" data-state="success" hidden>
          <div class="modal-icon-ring modal-icon-ring--success" aria-hidden="true">
            <div class="modal-icon-inner">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 12.5L10 17.5L20 7.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
          <h2 class="modal-title">Got it.</h2>
          <p class="modal-subtitle">Your save is waiting. Get the Tastely app and sign up with this email — your library picks up where you left off.</p>
          <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="modal-btn modal-btn-primary modal-btn-block" data-share-event="modal_get_app_after_capture">Get the Tastely app</a>
        </div>

        <!-- Existing-user state: don't create duplicate -->
        <div class="modal-state" data-state="existing" hidden>
          <div class="modal-icon-ring" aria-hidden="true">
            <div class="modal-icon-inner">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M3 12L10 19L21 8" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
          </div>
          <h2 class="modal-title">Welcome back.</h2>
          <p class="modal-subtitle">You already have a Tastely account. Open the app to complete this save.</p>
          <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="modal-btn modal-btn-primary modal-btn-block" data-share-event="modal_open_app_existing">Open Tastely</a>
        </div>

        <!-- Error state -->
        <div class="modal-state" data-state="error" hidden>
          <h2 class="modal-title">Hmm, that didn't work.</h2>
          <p class="modal-subtitle">Something went wrong on our end. Try again, or just grab the app directly.</p>
          <button class="modal-btn modal-btn-secondary" id="error-retry">Try again</button>
          <a href="https://apps.apple.com/app/tastely/id${APP_STORE_ID}" class="modal-btn modal-btn-primary modal-btn-block">Get the Tastely app</a>
        </div>
      </div>
    </div>`;
}

function renderModalScript(ctx: ModalContext): string {
  return `
<script>
(function(){
  // Share context wired up server-side; client uses for analytics + modal copy.
  var CTX = ${JSON.stringify({
    itemTitle: ctx.itemTitle,
    itemType: ctx.itemType,
    externalId: ctx.externalId,
    externalSource: ctx.externalSource,
    saveCtaLabel: ctx.saveCtaLabel,
  })};
  var ENDPOINT = ${JSON.stringify(ANALYTICS_ENDPOINT)};
  var SIGNUP_ENDPOINT = '/api/signup-from-share';

  function $(sel, root) { return (root||document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root||document).querySelectorAll(sel)); }

  // ── Analytics ──
  function logEvent(name, extra) {
    try {
      var payload = Object.assign({ event: name, ctx: CTX, ts: Date.now() }, extra || {});
      // Best-effort fire-and-forget. Use sendBeacon when available so the
      // request survives page-transitions (e.g. tap "Get the app" → leaving).
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(ENDPOINT, blob);
      } else {
        fetch(ENDPOINT, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      }
    } catch (e) {}
  }

  // ── Page-load impression ──
  logEvent('share_link.impression', { ua_summary: getUASummary() });

  function getUASummary() {
    var ua = navigator.userAgent || '';
    var platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios'
                 : /Android/i.test(ua) ? 'android'
                 : 'desktop';
    return platform;
  }

  // ── Action-pill bindings ──
  $$('[data-share-action]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var action = btn.getAttribute('data-share-action');
      openModal(action);
      logEvent('share_link.action_tapped', { action: action });
    });
  });

  // ── Sharer + sticky bar tap analytics ──
  $$('[data-share-event]').forEach(function(el){
    el.addEventListener('click', function(){
      logEvent(el.getAttribute('data-share-event'));
    });
  });

  // ── Modal open / close ──
  var modal = $('#signup-modal');
  var titleEl = $('#modal-title');
  var emailInput = $('#email-input');
  var emailForm = $('#email-form');
  var submitBtn = $('#email-submit');

  function openModal(action) {
    if (!modal) return;
    setState('signup');
    if (titleEl && action) {
      var copy = ({
        save: 'Save ' + truncate(CTX.itemTitle, 36) + ' to your library',
        board: 'Add ' + truncate(CTX.itemTitle, 32) + ' to a board',
        send: 'Send ' + truncate(CTX.itemTitle, 36) + ' to a friend',
        share: 'Share ' + truncate(CTX.itemTitle, 36) + ' with friends',
        rate: 'Rate ' + truncate(CTX.itemTitle, 36),
      })[action] || ('Save ' + truncate(CTX.itemTitle, 36));
      titleEl.textContent = copy;
    }
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function(){ if (emailInput) emailInput.focus(); }, 120);
  }

  function closeModal() {
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function setState(name) {
    $$('.modal-state').forEach(function(s){
      if (s.getAttribute('data-state') === name) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    });
  }

  function truncate(s, n) {
    if (!s) return '';
    if (s.length <= n) return '"' + s + '"';
    return '"' + s.slice(0, n - 1) + '…"';
  }

  // Close handlers
  var closeBtn = $('#modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', function(e){
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeModal();
  });

  // ── Email form submit ──
  if (emailForm) {
    emailForm.addEventListener('submit', function(e){
      e.preventDefault();
      var email = (emailInput && emailInput.value || '').trim();
      if (!email) return;
      submitBtn.classList.add('loading');
      submitBtn.disabled = true;
      logEvent('share_link.email_submitted', { email_domain: email.split('@')[1] || '' });

      fetch(SIGNUP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          item_external_id: CTX.externalId,
          item_external_source: CTX.externalSource,
          item_type: CTX.itemType
        })
      })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, data: j }; }); })
      .then(function(res){
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
        if (res.ok && res.data && res.data.was_existing_user) {
          setState('existing');
        } else if (res.ok) {
          setState('success');
        } else {
          setState('error');
        }
      })
      .catch(function(){
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
        setState('error');
      });
    });
  }

  // Error retry → back to signup
  var retryBtn = $('#error-retry');
  if (retryBtn) retryBtn.addEventListener('click', function(){ setState('signup'); });
})();
</script>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Styles — inlined for one-request render
// ─────────────────────────────────────────────────────────────────────────

const BASE_STYLES = `<style>
  *,*::before,*::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0F0F0F;
    --surface: #1A1A1A;
    --surface-alt: #161616;
    --border: #2A2A2A;
    --border-hover: #3A3A3A;
    --text: #FFFFFF;
    --text-2: #D1D5DB;
    --text-3: #9CA3AF;
    --text-4: #6B7280;
    --brand-purple: #8b52ee;
    /* Hero CTA = Fuchsia v2 smoothed gradient — locked at .claude/docs/ux-buttons.md §1.
       Brand purple is scarce signal; gradient lives ONLY on hero CTAs (the sticky-bar
       "Get the app" + modal primary "Save my spot" / "Get the Tastely app"). Companion
       CTAs use ghost-outline; everything else stays neutral. */
    --brand-grad: linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.04) 40%, transparent 100%),
                  linear-gradient(125deg, #8b52ee 0%, #a85eee 35%, #c459ee 65%, #df53ee 100%);
    --brand-shadow: 0 4px 16px rgba(139, 82, 238, 0.32);
  }

  html, body { background: var(--bg); color: var(--text); min-height: 100%; }
  body {
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
    font-weight: 400;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
    position: relative;
    padding-bottom: calc(96px + env(safe-area-inset-bottom));
  }

  a { color: inherit; text-decoration: none; }

  /* ── Film-grain overlay ── */
  .grain {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    opacity: 0.05;
    mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.5 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  /* ── Chrome ── */
  .chrome {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px;
    padding-top: max(18px, env(safe-area-inset-top, 18px));
    max-width: 560px;
    margin: 0 auto;
  }
  .chrome-logo img { display: block; height: 88px; width: auto; opacity: 0.95; }
  .chrome-signin {
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    font-size: 13px;
    color: var(--text-2);
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    transition: all 0.18s ease;
  }
  .chrome-signin:hover {
    color: var(--text);
    border-color: var(--border-hover);
    background: rgba(255,255,255,0.03);
  }

  /* ── Hero glow halo ── */
  .hero-glow {
    position: absolute;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    width: min(540px, 100vw);
    height: 540px;
    border-radius: 50%;
    filter: blur(110px);
    pointer-events: none;
    z-index: 0;
    opacity: 0.55;
    animation: glowPulse 12s ease-in-out infinite;
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1); }
    50% { opacity: 0.40; transform: translateX(-50%) scale(1.08); }
  }

  /* ── Container ── */
  .container {
    position: relative;
    z-index: 2;
    max-width: 560px;
    margin: 0 auto;
    padding: 12px 20px 32px;
  }

  /* ── Sharer attribution row ── */
  .sharer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 14px;
    margin: 0 -4px 16px;
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(139,82,238,0.08), rgba(139,82,238,0.02));
    border: 1px solid rgba(139,82,238,0.15);
    transition: all 0.2s ease;
  }
  .sharer:hover {
    background: linear-gradient(180deg, rgba(139,82,238,0.13), rgba(139,82,238,0.04));
    border-color: rgba(139,82,238,0.3);
    transform: translateY(-1px);
  }
  .sharer-avatar {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.18);
    overflow: hidden;
  }
  .sharer-avatar img,
  .sharer-avatar-fallback {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 15px;
    object-fit: cover;
  }
  .sharer-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }
  .sharer-name {
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .sharer-suffix {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 13px;
    color: var(--text-3);
    font-style: italic;
  }
  .sharer-arrow {
    color: var(--text-4);
    font-size: 18px;
    transition: transform 0.2s ease, color 0.2s ease;
  }
  .sharer:hover .sharer-arrow {
    color: var(--brand-pink);
    transform: translateX(2px);
  }

  /* ── Detail layout (used by adapter bodies) ── */
  .detail-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0 20px;
  }
  .detail-cover {
    width: min(220px, 60vw);
    aspect-ratio: 2/3;
    border-radius: 14px;
    object-fit: cover;
    background: var(--surface);
    box-shadow: 0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
    margin-bottom: 22px;
  }
  .detail-cover-square {
    aspect-ratio: 1/1;
    border-radius: 50%;
    width: min(180px, 50vw);
  }
  .detail-eyebrow {
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: var(--brand-purple);
    margin-bottom: 8px;
  }
  .detail-title {
    font-family: 'Inter', sans-serif;
    font-weight: 800;
    font-size: clamp(26px, 6vw, 34px);
    line-height: 1.08;
    letter-spacing: -0.5px;
    color: var(--text);
    margin: 0 0 6px;
    text-wrap: balance;
  }
  .detail-subtitle {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 15px;
    color: var(--text-2);
    margin: 0 0 10px;
  }
  .detail-meta {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 13px;
    color: var(--text-3);
    letter-spacing: 0.2px;
  }
  .detail-meta .dot { margin: 0 6px; opacity: 0.6; }

  /* ── Action pills row — single row on phone ── */
  .actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin: 18px 0 28px;
    flex-wrap: nowrap;
  }
  .pill {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    font-size: 13px;
    padding: 9px 12px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    cursor: pointer;
    transition: all 0.18s ease;
    -webkit-tap-highlight-color: transparent;
    flex: 1 1 0;
    min-width: 0;
    white-space: nowrap;
  }
  .pill:hover {
    color: var(--text);
    background: var(--surface-alt);
    border-color: var(--border-hover);
    transform: translateY(-1px);
  }
  .pill svg { width: 14px; height: 14px; flex-shrink: 0; }

  /* ── Body sections ── */
  .section { margin: 28px 0; }
  .section-label {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 1.4px;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 12px;
  }
  .section-prose {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 15px;
    line-height: 1.65;
    color: var(--text-2);
  }

  /* ── Cast / similar / providers strips ── */
  .strip {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 6px;
    scrollbar-width: none;
    margin: 0 -20px;
    padding-left: 20px;
    padding-right: 20px;
  }
  .strip::-webkit-scrollbar { display: none; }
  .strip-cell {
    flex-shrink: 0;
    width: 96px;
    text-align: center;
  }
  .strip-cell-img {
    width: 96px;
    height: 144px;
    border-radius: 10px;
    object-fit: cover;
    background: var(--surface);
    margin-bottom: 6px;
  }
  .strip-cell-img--circle {
    border-radius: 50%;
    width: 80px;
    height: 80px;
    margin: 0 auto 6px;
  }
  .strip-cell-name {
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    font-size: 12px;
    line-height: 1.25;
    color: var(--text);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .strip-cell-sub {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 11px;
    color: var(--text-3);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Provider chips ── */
  .providers {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .provider-chip {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 13.5px;
    color: var(--text);
    transition: all 0.18s ease;
    line-height: 1;
  }
  /* Icon-shape logos (Amazon symbol, Apple icon, BAM icon) — square,
     paired with brand-name text. */
  .provider-icon {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    object-fit: contain;
    flex-shrink: 0;
  }
  /* Wordmark-shape logos (B&N, Bookshop, Kobo) — render alone, no text
     alongside (wordmark already shows the brand name). */
  .provider-wordmark {
    height: 18px;
    width: auto;
    max-width: 130px;
    object-fit: contain;
    display: block;
  }
  .provider-chip--wordmark {
    padding: 9px 16px;
  }
  .provider-name { line-height: 1; }
  .provider-chip--link {
    text-decoration: none;
    cursor: pointer;
  }
  .provider-chip--link:hover {
    background: var(--surface-alt);
    border-color: var(--border-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }
  .provider-chip--link:active {
    transform: translateY(0);
  }

  /* ── Trust footer ── */
  .trust-footer {
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    text-align: center;
  }
  .trust-copyright {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    color: var(--text-4);
  }

  /* ── Sticky bar ── */
  .sticky-bar {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px calc(14px + env(safe-area-inset-bottom, 0px));
    background: rgba(15, 15, 15, 0.85);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border-top: 1px solid rgba(139, 82, 238, 0.18);
  }
  .sticky-bar-text {
    font-family: 'Outfit', sans-serif;
    font-weight: 500;
    font-size: 13px;
    color: var(--text-2);
    letter-spacing: 0.1px;
  }
  .sticky-bar-cta {
    flex-shrink: 0;
    background: var(--brand-grad);
    color: white;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 13px;
    padding: 10px 20px;
    border-radius: 999px;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    box-shadow: var(--brand-shadow);
    letter-spacing: 0.1px;
  }
  .sticky-bar-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 22px rgba(139, 82, 238, 0.45);
  }

  /* ── Modal ── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.22s ease;
  }
  .modal-backdrop.open {
    opacity: 1;
    pointer-events: auto;
  }
  .modal {
    position: relative;
    width: 100%;
    max-width: 440px;
    background: var(--surface);
    border-radius: 22px 22px 0 0;
    padding: 28px 24px calc(28px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid rgba(255,255,255,0.06);
    transform: translateY(20px);
    transition: transform 0.32s cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  .modal-backdrop.open .modal { transform: translateY(0); }

  @media (min-width: 540px) {
    .modal-backdrop { align-items: center; padding: 24px; }
    .modal {
      border-radius: 22px;
      padding-bottom: 28px;
      transform: scale(0.96) translateY(0);
    }
    .modal-backdrop.open .modal { transform: scale(1) translateY(0); }
  }

  .modal-close {
    position: absolute;
    top: 14px;
    right: 14px;
    background: rgba(255,255,255,0.06);
    border: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--text-2);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.18s ease, color 0.18s ease;
  }
  .modal-close:hover { background: rgba(255,255,255,0.12); color: var(--text); }

  /* Neutral by doctrine — gradient is reserved for hero CTAs only.
     The icon's job here is wayfinding ("this is a save flow"), not brand. */
  .modal-icon-ring {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(139, 82, 238, 0.12);
    border: 1px solid rgba(139, 82, 238, 0.22);
    margin: 6px auto 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--brand-purple);
  }
  .modal-icon-ring--success {
    background: rgba(52, 211, 153, 0.12);
    border-color: rgba(52, 211, 153, 0.28);
    color: #34D399;
  }
  .modal-icon-inner { display: contents; }
  .modal-icon-inner svg path { stroke: currentColor; }

  .modal-title {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 20px;
    line-height: 1.25;
    text-align: center;
    color: var(--text);
    margin-bottom: 8px;
    letter-spacing: -0.2px;
    text-wrap: balance;
  }
  .modal-subtitle {
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 14px;
    line-height: 1.5;
    text-align: center;
    color: var(--text-3);
    margin-bottom: 22px;
  }

  .modal-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .modal-btn {
    appearance: none;
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14.5px;
    padding: 13px 18px;
    border-radius: 12px;
    transition: all 0.18s ease;
    width: 100%;
    text-align: center;
    -webkit-tap-highlight-color: transparent;
  }
  /* Companion CTA per ux-buttons.md §2 — ghost outline, no brand color. */
  .modal-btn-oauth {
    background: transparent;
    color: var(--text);
    border: 1.5px solid rgba(255, 255, 255, 0.18);
  }
  .modal-btn-oauth:hover {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255, 255, 255, 0.28);
  }
  /* Hero CTA per ux-buttons.md §1 — Fuchsia v2 gradient + soft sheen. */
  .modal-btn-primary {
    background: var(--brand-grad);
    color: white;
    box-shadow: var(--brand-shadow);
    position: relative;
    letter-spacing: 0.1px;
  }
  .modal-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 22px rgba(139, 82, 238, 0.45);
  }
  .modal-btn-primary:disabled {
    opacity: 0.7;
    cursor: not-allowed;
    transform: none;
  }
  .modal-btn-secondary {
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
  }
  .modal-btn-block { margin-top: 10px; }

  .modal-btn-spinner {
    display: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: white;
    animation: spin 0.7s linear infinite;
  }
  .modal-btn.loading .modal-btn-label { display: none; }
  .modal-btn.loading .modal-btn-spinner { display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .modal-divider {
    text-align: center;
    margin: 18px 0 14px;
    position: relative;
  }
  .modal-divider::before {
    content: '';
    position: absolute;
    inset: 50% 0;
    height: 1px;
    background: var(--border);
  }
  .modal-divider span {
    position: relative;
    background: var(--surface);
    padding: 0 12px;
    font-family: 'Outfit', sans-serif;
    font-weight: 400;
    font-size: 12px;
    color: var(--text-4);
    letter-spacing: 0.4px;
  }

  .modal-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .modal-form input {
    appearance: none;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    padding: 13px 16px;
    border-radius: 12px;
    width: 100%;
    transition: border-color 0.18s ease, background 0.18s ease;
  }
  .modal-form input:focus {
    outline: none;
    border-color: var(--brand-purple);
    background: rgba(139, 82, 238, 0.08);
  }
  .modal-form input::placeholder { color: var(--text-4); }

  .modal-fineprint {
    font-family: 'Outfit', sans-serif;
    font-size: 11.5px;
    color: var(--text-4);
    text-align: center;
    margin-top: 14px;
    line-height: 1.45;
  }

  /* Reduced motion respect */
  @media (prefers-reduced-motion: reduce) {
    .hero-glow { animation: none; }
    *, *::before, *::after { transition: none !important; animation: none !important; }
  }

  /* ── Legacy classes for board + user routes (pre-S140) ──
     Kept until those routes are refactored to the new class system.
     Removing these would break /library/[id] and /user/[id] body rendering. */
  .logo {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 20px;
    color: var(--brand-purple);
    margin-bottom: 24px;
  }
  .header { margin-bottom: 24px; }
  .tag-label {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    color: var(--brand-purple);
    margin-bottom: 8px;
  }
  .container h1 {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 24px;
    line-height: 1.2;
    margin-bottom: 6px;
  }
  .subtitle { font-size: 14px; color: var(--text-3); }
  .description { font-size: 14px; color: var(--text-4); margin-top: 8px; line-height: 1.5; }
  .item-list { display: flex; flex-direction: column; gap: 12px; }
  .item-card {
    display: flex;
    gap: 12px;
    background: var(--surface);
    border-radius: 12px;
    padding: 10px;
    border: 1px solid var(--border);
  }
  .poster { width: 56px; height: 84px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: #252525; }
  .poster-placeholder { width: 56px; height: 84px; background: #252525; border-radius: 6px; }
  .item-info { display: flex; flex-direction: column; justify-content: center; }
  .item-title { font-weight: 500; font-size: 15px; margin-bottom: 4px; }
  .item-meta { font-size: 13px; color: var(--text-3); }
  .profile-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .avatar {
    width: 72px; height: 72px; border-radius: 50%;
    object-fit: cover; background: #252525; flex-shrink: 0;
  }
  .profile-info h1 { margin-bottom: 2px; }
  .profile-handle { font-size: 14px; color: var(--text-3); }
  .profile-bio { font-size: 14px; color: var(--text-2); line-height: 1.5; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .grid-item { aspect-ratio: 2/3; border-radius: 8px; overflow: hidden; background: #252525; }
  .grid-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cta { margin-top: 32px; text-align: center; }
  .cta-text { font-size: 14px; color: var(--text-4); margin-bottom: 12px; }
  .cta-button {
    display: inline-block;
    background: var(--brand-grad);
    color: white;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 15px;
    padding: 12px 32px;
    border-radius: 24px;
    transition: opacity 0.2s, transform 0.2s;
  }
  .cta-button:hover { opacity: 0.9; transform: translateY(-1px); }
  .empty { color: var(--text-4); text-align: center; padding: 32px; }
</style>`;

function heroGlowStyle(rgb: string): string {
  return `<style>
  .hero-glow {
    background: radial-gradient(circle, rgba(${rgb}, 0.22) 0%, rgba(${rgb}, 0.06) 45%, transparent 70%);
  }
</style>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Not-found page (uses same chrome — failure shouldn't feel off-brand)
// ─────────────────────────────────────────────────────────────────────────

export function notFoundPage(message: string, status = 404): Response {
  const html = renderPage({
    ogTitle: 'Tastely',
    ogDescription: 'Discover better recommendations',
    ogImage: '',
    ogUrl: 'https://trytastely.com',
    body: `
      <div class="detail-hero" style="padding-top: 60px;">
        <h1 class="detail-title" style="margin-bottom: 14px;">Not found</h1>
        <p class="detail-subtitle" style="margin-bottom: 28px;">${escapeHtml(message)}</p>
        <a href="/" class="modal-btn modal-btn-primary" style="display: inline-flex; width: auto; padding: 12px 28px;">Discover Tastely</a>
      </div>`,
  });
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str: string): string {
  return escapeHtml(str);
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
