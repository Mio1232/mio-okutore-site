// netlify/functions/telecom-cancel-webhook.js
// テレコムクレジットの「退会通知（退会データ送信）」を受け取り、
// 該当ユーザーを無料プランに戻す（ダウングレード専用）。
//
// ※ 依存パッケージ不要：Supabase の REST API を fetch で直接呼び出します
//    （他の関数と同じ方式。@supabase/supabase-js は使いません）

const ALLOWED_IPS = ['54.65.177.67', '52.196.8.0', '54.238.8.174', '54.95.89.20'];

exports.handler = async (event) => {
  // GET / POST どちらでも受け取る（テレコムは既定でGET送信）
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 送信元IPチェック
  const ip = (event.headers['x-nf-client-connection-ip']
    || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (ALLOWED_IPS.length && !ALLOWED_IPS.includes(ip)) {
    console.warn('[cancel-webhook] 許可外IPからのアクセス:', ip);
    return { statusCode: 403, body: 'Forbidden' };
  }

  // パラメータ取得：GET（クエリ）と POST（ボディ）の両方に対応
  let params = {};
  if (event.queryStringParameters) {
    params = { ...event.queryStringParameters };
  }
  if (event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      params = { ...params, ...Object.fromEntries(new URLSearchParams(raw)) };
    } catch (e) {
      console.error('[cancel-webhook] ボディ解析エラー:', e);
    }
  }

  // 会員番号を取得。テレコムの退会通知では「member_id」で送られる（値は登録時の sendid と同一）
  const sendid = params.member_id || params.sendid || params.send_id || '';
  console.log('[cancel-webhook] 受信:', JSON.stringify({ ip, sendid, params }));

  if (!sendid) {
    console.warn('[cancel-webhook] sendid が見つかりません');
    return { statusCode: 200, body: 'SuccessOK' };
  }

  // Supabase REST API で該当ユーザーを無料プランに戻す（サービスロールキー使用）
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const url = SUPABASE_URL + '/rest/v1/profiles?telecom_sendid=eq.' + encodeURIComponent(sendid);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ plan: 'free', payment_status: 'cancelled' })
    });
    const result = await res.json().catch(() => null);
    if (!res.ok) {
      console.error('[cancel-webhook] Supabase更新エラー:', res.status, result);
    } else if (!result || result.length === 0) {
      console.warn('[cancel-webhook] 該当ユーザーなし sendid=', sendid);
    } else {
      console.log('[cancel-webhook] 無料プランに戻しました:', JSON.stringify(result));
    }
  } catch (e) {
    console.error('[cancel-webhook] 例外:', e);
  }

  // テレコムには成功応答（再送防止）
  return { statusCode: 200, body: 'SuccessOK' };
};
