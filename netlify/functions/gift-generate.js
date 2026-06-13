// netlify/functions/gift-generate.js
// 管理者がボタンで実行：最新のドル円・ゴールドのニュースをWeb検索で読み込み、
// mio口調のプレゼント記事＋シナリオ表を生成して返す（保存は管理画面側で行う）。
// 依存パッケージ不要（fetch のみ）。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'bad request' }); }
  const { user_id, focus } = body;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const API_KEY = process.env.ANTHROPIC_API_KEY;

  // 管理者チェック（サービスロールで確認）
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user_id || '') + '&select=is_admin', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const rows = await r.json();
    if (!rows || !rows[0] || rows[0].is_admin !== true) return resp(403, { error: '管理者のみ実行できます' });
  } catch (e) {
    return resp(500, { error: '権限の確認に失敗しました' });
  }

  const topic = focus === 'gold' ? 'ゴールド（XAUUSD）'
    : focus === 'usdjpy' ? 'ドル円（USD/JPY）'
    : 'ドル円（USD/JPY）とゴールド（XAUUSD）';

  const prompt =
    'あなたはFX教育コミュニティ「億トレ」の主宰・美桜Mio（みお）です。\n' +
    '今日の' + topic + 'に関する最新ニュース・経済指標・地政学リスク・重要な価格帯を、Web検索で実際に調べてください。\n' +
    'そのうえで、コミュニティ登録者へのプレゼント記事を作成します。\n\n' +
    '出力は必ず次のJSONのみ（前後に説明やコードブロック記号を付けない）：\n' +
    '{\n' +
    '  "title": "記事タイトル（30〜50字程度、引きのある見出し）",\n' +
    '  "body_html": "記事本文のHTML。使用タグは <h3> <p> <ul> <li> <strong> のみ。mioの口調（ですます調・🌸を時々）。導入＋3〜4セクション構成。",\n' +
    '  "table_html": "重要レベルやシナリオをまとめた<table>のHTML（属性やclassは付けない）。上昇/下落シナリオや節目の数字を入れる。"\n' +
    '}\n\n' +
    'ルール：\n' +
    '- 実際にWeb検索で確認した最新の数字・出来事を使うこと\n' +
    '- ニュース原文をそのまま転載せず、要点を自分の言葉でmio口調にまとめること\n' +
    '- 投資助言ではなく教育・情報提供として書くこと（断定的な売買指示はしない）\n' +
    '- ディスコードやEA・商品の宣伝文は入れないこと（別途ページ側で付与します）\n' +
    '- JSON以外は一切出力しないこと';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
          user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' }
        }]
      })
    });
    const data = await res.json();
    let text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return resp(200, {
      title: parsed.title || '今日の相場分析',
      body_html: parsed.body_html || '',
      table_html: parsed.table_html || ''
    });
  } catch (e) {
    console.error('[gift-generate] エラー:', e);
    return resp(500, { error: '生成に失敗しました。少し時間をおいて、もう一度お試しください。' });
  }
};

function resp(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
