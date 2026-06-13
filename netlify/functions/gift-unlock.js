// netlify/functions/gift-unlock.js
// ユーザーが入力したキーワードをサーバー側で照合し、
// 正しければ該当ユーザーの gift_unlocked を true にする。
// キーワードはクライアントに一切返さない（サービスロールで照合）。依存パッケージ不要。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { ok: false, error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { ok: false, error: 'bad request' }); }
  const { user_id, keyword } = body;
  if (!user_id || !keyword) return resp(400, { ok: false, error: '入力が不足しています' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 現在のキーワードを取得（サービスロール）
    const r = await fetch(SUPABASE_URL + '/rest/v1/gift_settings?id=eq.1&select=unlock_keyword', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const rows = await r.json();
    const current = ((rows && rows[0] && rows[0].unlock_keyword) || '').trim();

    if (!current) return resp(200, { ok: false, error: '現在キーワードが設定されていません。管理者にお問い合わせください。' });
    if (keyword.trim().toLowerCase() !== current.toLowerCase()) {
      return resp(200, { ok: false, error: 'キーワードが正しくありません🌸' });
    }

    // 解除フラグを立てる
    const up = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user_id), {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ gift_unlocked: true })
    });
    if (!up.ok) {
      console.error('[gift-unlock] profiles更新エラー:', up.status);
      return resp(500, { ok: false, error: '処理に失敗しました。もう一度お試しください。' });
    }
    return resp(200, { ok: true });
  } catch (e) {
    console.error('[gift-unlock] 例外:', e);
    return resp(500, { ok: false, error: '処理に失敗しました。もう一度お試しください。' });
  }
};

function resp(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
