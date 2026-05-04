// POST /api/signup-from-share
//
// Email-capture endpoint fired by the share-landing modal. The recipient
// taps an action pill (Save / Board / Send / Share) on a share-landing
// page, types an email, hits submit. We:
//   1. Check whether that email already has a Tastely account.
//      • Yes → return { was_existing_user: true }. UI shows "Welcome back".
//      • No  → insert a row in share_intents keyed to email + the item,
//             and return { was_existing_user: false }. UI shows "Got it".
//
// We do NOT send an email here (magic-link path was deferred at S140 —
// see plan §2.4). The modal handles the App Store bounce; the app-side
// AuthProvider drains pending intents on first session establish.
//
// All input is treated as untrusted. Validation:
//   • email      — required, must look like an email
//   • intent_type — defaults to 'save' if missing/invalid
//   • item_external_id, item_external_source, item_type — required
//   • sharer_user_id — optional, validated as UUID-shape

import { sbInsert, sbRpc, type SupabaseEnv } from '../_lib/supabase';

type Env = SupabaseEnv;

type Body = {
  email?: string;
  intent_type?: string;
  item_external_id?: string;
  item_external_source?: string;
  item_type?: string;
  sharer_user_id?: string;
};

const VALID_INTENT_TYPES = new Set(['save', 'board', 'send', 'share', 'rate']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const email = (payload.email ?? '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'invalid_email' }, 400);
  }

  const intentType = VALID_INTENT_TYPES.has(payload.intent_type ?? '')
    ? (payload.intent_type as string)
    : 'save';

  const itemExternalId = (payload.item_external_id ?? '').trim();
  const itemExternalSource = (payload.item_external_source ?? '').trim();
  const itemType = (payload.item_type ?? '').trim();
  if (!itemExternalId || !itemExternalSource || !itemType) {
    return jsonResponse({ error: 'missing_item_fields' }, 400);
  }

  const sharerId =
    payload.sharer_user_id && UUID_RE.test(payload.sharer_user_id)
      ? payload.sharer_user_id
      : null;

  // 1. Existing-user check.
  const exists = await sbRpc<boolean>(env, 'email_exists_in_auth', { p_email: email });
  if (exists === true) {
    return jsonResponse({ was_existing_user: true });
  }

  // 2. Insert intent. Don't surface the row id; minimal return.
  const insert = await sbInsert(env, {
    table: 'share_intents',
    body: {
      email,
      intent_type: intentType,
      item_external_id: itemExternalId,
      item_external_source: itemExternalSource,
      item_type: itemType,
      sharer_user_id: sharerId,
    },
  });

  if (!insert.ok) {
    return jsonResponse({ error: 'insert_failed' }, 502);
  }

  return jsonResponse({ was_existing_user: false });
};
