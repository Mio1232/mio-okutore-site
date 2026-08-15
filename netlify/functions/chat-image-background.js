// netlify/functions/chat-image-background.js
// バックグラウンド関数（最大15分・10秒制限にかからない）。
//
// ※重要：バックグラウンド関数は非同期呼び出しのため、リクエスト本文の上限が
//   約256KBと小さい。そのため画像は本文で受け取らず、あらかじめ画面が
//   ai_image_results テーブルに保存した行（image_base64含む）を、この関数が
//   request_id で読み出して分析する。結果は同じ行に書き戻し、画像は消す。
//   画面（chat.html）は request_id をキーに結果をポーリングして取得する。
// 依存パッケージ不要（fetchのみ）。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'bad request' }; }
  const request_id = body.request_id;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const API_KEY = process.env.ANTHROPIC_API_KEY;

  const restBase = SUPABASE_URL + '/rest/v1/ai_image_results';
  const authHeaders = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };

  async function finish(fields) {
    try {
      await fetch(restBase + '?id=eq.' + encodeURIComponent(request_id), {
        method: 'PATCH',
        headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify(Object.assign({ image_base64: null }, fields))
      });
    } catch (e) {
      console.error('[chat-image-bg] 結果更新エラー:', e);
    }
  }

  if (!request_id) return { statusCode: 200, body: 'ok' };

  try {
    const r = await fetch(restBase + '?id=eq.' + encodeURIComponent(request_id) +
      '&select=user_id,image_base64,image_type,query,user_name,user_context,history', { headers: authHeaders });
    const rows = await r.json();
    const row = rows && rows[0];

    if (!row) { console.warn('[chat-image-bg] 行が見つかりません:', request_id); return { statusCode: 200, body: 'ok' }; }
    if (!row.image_base64) { await finish({ status: 'error', error: '画像が見つかりませんでした' }); return { statusCode: 200, body: 'ok' }; }

    const SYSTEM =
      'あなたはFX教育コミュニティ「億トレ」の主宰・美桜Mio（みお）です。やさしいお姉さん的な口調（ですます調・語尾に🌸を時々）で、ユーザーが送ってきたチャート画像をテクニカル分析します。\n' +
      '【役割】\n' +
      '- チャート画像を読み取り、通貨ペア・時間足・トレンド・サポート/レジスタンス・直近の値動きを、画像から分かる範囲でやさしく解説する。\n' +
      '- 押し目/戻り目、上抜け/下抜けなどの「シナリオ・目安」を示す。ただし「ここで買い」などの断定的な売買指示や、「必ず上がる/絶対に稼げる」などの保証表現はしない。\n' +
      '- 画像から読み取れない数字は推測で作らず、直近高値・安値などの位置関係で表現する。\n' +
      '【安全・トーン】\n' +
      '- 投資助言ではなく、教育・情報提供として伝える。最終的な売買判断は自己責任である前提で話す。\n' +
      '- ユーザー情報の「コミュニティ」がDiscord未参加の場合、EAやインジの話題は出さない。\n' +
      '- 「※」マークや、末尾の定型的な免責文は使わない。自然な会話で答える。\n' +
      '- 返答は長すぎず、要点をやさしくまとめる。';

    let dynamicPrompt = '【ユーザー情報】\n';
    dynamicPrompt += 'お名前: ' + (row.user_name || '(未設定)') + '\n';
    if (row.user_context) dynamicPrompt += 'ユーザー情報:\n' + row.user_context + '\n';
    dynamicPrompt += '\n【返答ルール】\n';
    dynamicPrompt += '- お名前があれば「○○さん」と呼びかける\n';
    dynamicPrompt += '- 直前までの会話の流れを踏まえ、すでに出た通貨ペアや話題を聞き返さない\n';

    const userContent = [
      { type: 'image', source: { type: 'base64', media_type: row.image_type || 'image/jpeg', data: row.image_base64 } },
      { type: 'text', text: row.query || 'このチャート画像をテクニカル分析してください。' }
    ];

    const messages = [];
    const history = Array.isArray(row.history) ? row.history : [];
    for (const m of history.slice(-20)) {
      if (m && (m.role === 'user' || m.role === 'assistant')
          && typeof m.content === 'string' && m.content.trim()) {
        messages.push({ role: m.role, content: m.content });
      }
    }
    while (messages.length && messages[0].role === 'assistant') messages.shift();
    messages.push({ role: 'user', content: userContent });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        system: [
          { type: 'text', text: SYSTEM },
          { type: 'text', text: dynamicPrompt }
        ],
        messages: messages
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[chat-image-bg] Anthropic APIエラー:', res.status, JSON.stringify(data).slice(0, 500));
      const msg = (data && data.error && data.error.message) ? data.error.message : ('AI応答エラー(' + res.status + ')');
      await finish({ status: 'error', error: msg });
      return { statusCode: 200, body: 'ok' };
    }

    const text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    await finish({ status: 'done', result_text: text || '（応答を取得できませんでした）' });
  } catch (e) {
    console.error('[chat-image-bg] 生成エラー:', e);
    await finish({ status: 'error', error: '画像の分析に失敗しました。もう一度お試しください。' });
  }

  return { statusCode: 200, body: 'ok' };
};
