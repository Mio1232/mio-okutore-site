// netlify/functions/telecom-webhook.js
//
// テレコムクレジットの「決済データ受け取り（Webhook）」を処理する関数。
// 追加パッケージ不要：Node標準の fetch で Supabase REST API を呼びます。
//
// 仕様上のルール（重要）:
//   - 受け取ったら本文に "SuccessOK" を出力し、HTTPステータス200を返す。
//   - 200 / SuccessOK が確認できないと、約5分間隔で最大3時間 再送される。
//   - 署名は無いため、送信元IPの検証で なりすまし を防ぐ。
//   - 同じ決済が複数回届きうるので settle_uuid で重複反映を防止する。
//
// 必要な環境変数（Netlify）:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY     ... 設定済み
//   TELECOM_CLIENTIP / TELECOM_REBILL_BASIC / TELECOM_REBILL_PRO ... テレコムの返事後に設定
//   TELECOM_ALLOWED_IPS / TELECOM_ENFORCE_IP_CHECK ... 任意

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TELECOM_CLIENTIP = process.env.TELECOM_CLIENTIP || '';
const REBILL_BASIC = process.env.TELECOM_REBILL_BASIC || '';
const REBILL_PRO = process.env.TELECOM_REBILL_PRO || '';

const DEFAULT_ALLOWED_IPS = ['54.65.177.67', '52.196.8.0', '54.238.8.174', '54.95.89.20'];
const ALLOWED_IPS = process.env.TELECOM_ALLOWED_IPS
  ? process.env.TELECOM_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_IPS;
const ENFORCE_IP_CHECK = process.env.TELECOM_ENFORCE_IP_CHECK !== 'false';

const SUCCESS_BODY = 'SuccessOK';
const ok = (body = SUCCESS_BODY) => ({ statusCode: 200, body });
const fail = (statusCode, body) => ({ statusCode, body });

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function getClientIp(event) {
  const h = event.headers || {};
  const direct = h['x-nf-client-connection-ip'];
  if (direct) return direct.trim();
  const xff = h['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return '';
}

// GET（デフォルト）はクエリ文字列、POST（切替後）は form-urlencoded のbodyで届く。
function parseParams(event) {
  const params = {};
  if (event.queryStringParameters) Object.assign(params, event.queryStringParameters);
  if (event.body) {
    let body = event.body;
    if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
    const sp = new URLSearchParams(body);
    for (const [k, v] of sp.entries()) params[k] = v;
  }
  return params;
}

function planFromRebill(rebillId) {
  if (rebillId && rebillId === REBILL_BASIC) return 'basic';
  if (rebillId && rebillId === REBILL_PRO) return 'pro';
  return null;
}

exports.handler = async (event) => {
  // 1) 送信元IP検証（署名が無い代わりの防御線）
  const clientIp = getClientIp(event);
  if (ENFORCE_IP_CHECK && !ALLOWED_IPS.includes(clientIp)) {
    console.warn('[telecom-webhook] 許可されていないIP:', clientIp);
    return fail(403, 'forbidden');
  }

  // 2) パラメータ取得
  const p = parseParams(event);
  const { clientip, money, sendid, rel, cont, settle_uuid, rebill_param_id, settle_count, retry_active } = p;

  // 3) 必須値の確認
  if (!settle_uuid || !sendid) {
    console.warn('[telecom-webhook] 必須パラメータ不足:', p);
    return fail(400, 'bad request');
  }

  // 4) 自社clientipと一致するか
  if (TELECOM_CLIENTIP && clientip && clientip !== TELECOM_CLIENTIP) {
    console.warn('[telecom-webhook] clientip不一致:', clientip);
    return fail(403, 'forbidden');
  }

  try {
    // 5) 冪等性チェック：処理済みの settle_uuid なら副作用なしでSuccessOK
    const checkUrl = `${SUPABASE_URL}/rest/v1/payment_events?settle_uuid=eq.${encodeURIComponent(settle_uuid)}&select=settle_uuid`;
    const checkRes = await fetch(checkUrl, { headers: sbHeaders() });
    if (!checkRes.ok) throw new Error(`check failed: ${checkRes.status}`);
    const existing = await checkRes.json();
    if (Array.isArray(existing) && existing.length > 0) return ok();

    // 6) sendid からユーザーを特定
    const profUrl = `${SUPABASE_URL}/rest/v1/profiles?telecom_sendid=eq.${encodeURIComponent(sendid)}&select=id,plan`;
    const profRes = await fetch(profUrl, { headers: sbHeaders() });
    if (!profRes.ok) throw new Error(`profile lookup failed: ${profRes.status}`);
    const profiles = await profRes.json();
    const profile = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;

    const isSuccess = rel === 'yes';
    const plan = planFromRebill(rebill_param_id);

    // 7) プラン反映（setは冪等なので再適用されても安全）
    if (profile) {
      let patchBody = null;
      if (isSuccess && plan) patchBody = { plan, payment_status: 'active' };
      else if (!isSuccess) patchBody = { payment_status: 'payment_failed' };
      if (patchBody) {
        const upUrl = `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}`;
        const upRes = await fetch(upUrl, {
          method: 'PATCH',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify(patchBody),
        });
        if (!upRes.ok) throw new Error(`profile update failed: ${upRes.status}`);
      }
    } else {
      console.warn('[telecom-webhook] 対応ユーザー無し sendid=', sendid);
    }

    // 8) 処理済みとして記録（最後に行うことで、途中失敗時は再送で再処理される）
    const insUrl = `${SUPABASE_URL}/rest/v1/payment_events`;
    const insRes = await fetch(insUrl, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        settle_uuid,
        sendid,
        rebill_param_id: rebill_param_id || null,
        money: money || null,
        rel: rel || null,
        cont: cont || null,
        settle_count: settle_count || null,
        retry_active: retry_active || null,
        plan_applied: isSuccess && profile ? plan : null,
        raw: p,
      }),
    });
    if (insRes.status === 409) return ok(); // 既に記録済み（重複）
    if (!insRes.ok) throw new Error(`event insert failed: ${insRes.status}`);

    // 9) 受領応答。これが確認できないと再送が続く。
    return ok();
  } catch (err) {
    console.error('[telecom-webhook] 処理エラー:', err);
    return fail(500, 'error');
  }
};
