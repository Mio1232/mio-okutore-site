// netlify/functions/telecom-cancel-webhook.js
// テレコムクレジットの「退会通知（退会データ送信）」を受け取り、
// 該当ユーザーを無料プランに戻す（ダウングレード専用）。
//
// ※ 送信パラメータ名（特に会員番号 = sendid に相当する項目）と
//    期待されるレスポンスは、テレコムの「退会データ仕様」を確認のうえ
//    必要であれば調整してください。下記は一般的な想定での実装です。

const { createClient } = require('@supabase/supabase-js');

// テレコムの送信元IP（決済Webhookと同じ許可リスト）
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

  // 会員番号（sendid）を取得。仕様確定後に正しいパラメータ名へ合わせる
  const sendid = params.sendid || params.send_id || params.user_id || '';
  console.log('[cancel-webhook] 受信:', JSON.stringify({ ip, sendid, params }));

  if (!sendid) {
    console.warn('[cancel-webhook] sendid が見つかりません');
    return { statusCode: 200, body: 'SuccessOK' };
  }

  // Supabase（サービスロールキーで更新）
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 該当ユーザーを無料プランに戻す
  const { data, error } = await supabase
    .from('profiles')
    .update({ plan: 'free', payment_status: 'cancelled' })
    .eq('telecom_sendid', sendid)
    .select('id, email');

  if (error) {
    console.error('[cancel-webhook] profiles更新エラー:', error);
  } else if (!data || data.length === 0) {
    console.warn('[cancel-webhook] 該当ユーザーなし sendid=', sendid);
  } else {
    console.log('[cancel-webhook] 無料プランに戻しました:', JSON.stringify(data));
  }

  // テレコムには成功応答（再送防止）
  return { statusCode: 200, body: 'SuccessOK' };
};
