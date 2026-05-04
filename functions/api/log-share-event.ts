// POST /api/log-share-event
//
// Analytics sink for share-landing telemetry. Receives sendBeacon /
// fetch keepalive POSTs from the share page (impressions, action-taps,
// email-submits) and inserts a row into share_link_events.
//
// Best-effort: always returns 204 even on insert failures so that
// sendBeacon never logs an error to the recipient's console. Bad input
// is silently dropped — analytics noise should never break the page.
//
// Plan §2.9 events:
//   share_link.impression       (server-side from page render — TODO)
//   share_link.action_tapped    (client when pill tapped)
//   share_link.email_submitted  (client when email form submits)
//   share_link.intent_consumed  (app-side, not via this endpoint)

import { sbInsert, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type Ctx = {
  itemTitle?: string;
  itemType?: string;
  externalId?: string;
  externalSource?: string;
  saveCtaLabel?: string;
};

type Body = {
  event?: string;
  ctx?: Ctx;
  ts?: number;
  ua_summary?: string;
  action?: string;
  email_domain?: string;
};

const VALID_EVENTS = new Set([
  'share_link.impression',
  'share_link.action_tapped',
  'share_link.email_submitted',
]);

const NO_CONTENT = new Response(null, { status: 204 });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NO_CONTENT;
  }

  const eventType = payload.event ?? '';
  if (!VALID_EVENTS.has(eventType)) {
    return NO_CONTENT;
  }

  const cf = (request as unknown as { cf?: { country?: string } }).cf;
  const country = cf?.country ?? null;

  const clientTs =
    typeof payload.ts === 'number' && payload.ts > 0
      ? new Date(payload.ts).toISOString()
      : null;

  const row: Record<string, unknown> = {
    event_type: eventType,
    share_type: payload.ctx?.itemType ?? null,
    external_id: payload.ctx?.externalId ?? null,
    external_source: payload.ctx?.externalSource ?? null,
    action: payload.action ?? null,
    recipient_ua_summary: payload.ua_summary ?? null,
    recipient_country: country,
    client_ts: clientTs,
    payload: {
      ...(payload.email_domain ? { email_domain: payload.email_domain } : {}),
      ...(payload.ctx?.itemTitle ? { item_title: payload.ctx.itemTitle } : {}),
    },
  };

  // Fire-and-forget; ignore the result. Analytics should never block.
  await sbInsert(env, { table: 'share_link_events', body: row });

  return NO_CONTENT;
};
