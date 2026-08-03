// netlify/functions/gift-generate-background.js
// バックグラウンド関数（最大15分・504にならない）。
// 最新のドル円・ゴールドのニュースをWeb検索で読み込み、mio口調の記事を生成して
// gift_contents に下書き(status='draft')として保存する。
// 呼び出し元には即座に202が返り、生成は裏で継続する。依存パッケージ不要。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'bad request' }; }
  const { user_id, focus } = body;
  const indicators = Array.isArray(body.indicators)
    ? body.indicators.filter(x => x && (x.name || '').trim())
    : [];
  const images = Array.isArray(body.images)
    ? body.images.filter(x => x && x.data).slice(0, 3)
    : [];

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const API_KEY = process.env.ANTHROPIC_API_KEY;

  // 管理者チェック（サービスロールで確認）
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user_id || '') + '&select=is_admin', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const rows = await r.json();
    if (!rows || !rows[0] || rows[0].is_admin !== true) {
      console.warn('[gift-generate-bg] 管理者以外の呼び出しを拒否');
      return { statusCode: 403, body: 'forbidden' };
    }
  } catch (e) {
    console.error('[gift-generate-bg] 権限確認エラー:', e);
    return { statusCode: 500, body: 'error' };
  }

  let prompt, maxTokens, useWebSearch = true, imageContent = null;

  if (images.length) {
    // ===== チャート画像モード：画像を読み取り、写っている価格をもとに記事化 =====
    // use_news が true のときだけ、最新ニュースもWeb検索で参考にする（価格は画像優先）
    useWebSearch = !!body.use_news;
    maxTokens = 4000;
    const ctx = (body.chart_context || '').trim();
    const newsNote = body.use_news
      ? '\nまた、対象の通貨ペアの最新ニュース・経済指標・要人発言・地政学リスクなどをWeb検索で調べ、相場の「背景の材料」として本文に反映してください。ただし、価格・サポート/レジスタンス・現在値は必ずチャート画像から読み取った数字を使い、ニュースの数字で上書きしないこと。'
      : '';
    const imagePrompt =
      'あなたはFX教育コミュニティ「億トレ」の主宰・美桜Mio（みお）です。\n' +
      '添付されたチャート画像を実際に読み取り、そこに写っている価格・サポート/レジスタンス・トレンド・直近の値動きだけをもとに、コミュニティ登録者へのプレゼント記事を作成します。\n' +
      (ctx ? ('【補足メモ】' + ctx + '\n') : '') +
      '複数枚ある場合は、まず各チャートの銘柄（ドル円 USD/JPY か ゴールド XAUUSD かなど）を、画像内の表示や補足メモから判断してください。ドル円・ゴールドのどちらにも対応します。同じ銘柄の複数時間足なら、大きな流れ（上位足）と直近の目線（下位足）を関連づけてMTFで分析してください。ドル円とゴールドの両方が含まれる場合は、銘柄ごとに<h3>の見出しを分けて、それぞれ分析してください。' + newsNote + '\n\n' +
      '出力は必ず次のJSONのみ（前後に説明やコードブロック記号を付けない）：\n' +
      '{\n' +
      '  "title": "記事タイトル（30〜50字程度、引きのある見出し）",\n' +
      '  "body_html": "記事本文のHTML。使用タグは <h3> <p> <ul> <li> <strong> のみ。mioの口調（ですます調・🌸を時々）。導入＋現状分析＋上昇シナリオ＋下落シナリオ＋まとめ。最後に、この分析はチャート時点のものであり、最終的な売買判断は自己責任である旨を一言添える。",\n' +
      '  "table_html": "チャートから読み取った主要レベルとシナリオをまとめた<table>のHTML（属性やclassは付けない）。まず読み取った現在値付近・主要なサポート/レジスタンスの価格を行にし、続けて上昇シナリオ・下落シナリオの想定を入れる。ドル円とゴールドなど銘柄が複数ある場合は、銘柄ごとに分けて記載する。"\n' +
      '}\n\n' +
      'ルール：\n' +
      '- 価格やレベルは、チャート画像から実際に読み取れる数字だけを使うこと。画像に無い数字を推測で作らないこと。読み取りに自信がない箇所は無理に数値を書かず、直近高値・安値などの位置関係で表現すること。\n' +
      '- 断定的な売買指示（「ここで買い」等）はせず、「◯◯を上抜けたら上昇を意識」のようなシナリオ・目安の書き方にすること\n' +
      '- 「必ず上がる/下がる」「絶対に稼げる」などの保証表現は禁止すること\n' +
      '- 投資助言ではなく教育・情報提供として書くこと\n' +
      '- ディスコードやEA・商品の宣伝文は入れないこと（別途ページ側で付与します）\n' +
      '- JSON以外は一切出力しないこと';
    const imageBlocks = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type || 'image/jpeg', data: img.data }
    }));
    imageContent = imageBlocks.concat([{ type: 'text', text: imagePrompt }]);
  } else if (indicators.length) {
    // ===== 経済指標モード：指標→ファンダ検索→ドル円/ゴールドの想定＋ロング/ショート一択 =====
    const lines = indicators.map(x =>
      '- 指標名: ' + (x.name || '').trim() +
      ' / 前回値: ' + ((x.prev || '').trim() || '-') +
      ' / 予想値: ' + ((x.forecast || '').trim() || '-')
    ).join('\n');
    maxTokens = 4000;
    prompt =
      'あなたはFX教育コミュニティ「億トレ」の主宰・美桜Mio（みお）です。\n' +
      'これから渡す経済指標について、Web検索で関連するファンダメンタルズ（市場の最新予想、直近の関連ニュース、FRB・日銀の金融政策スタンス、地政学リスクなど）を実際に調べてください。\n' +
      'そのうえで、各指標が「ドル円（USD/JPY）」と「ゴールド（XAUUSD）」にどう影響しやすいかを分析し、トレード方向の一択（ロング または ショート）を示すプレゼント記事を作成します。\n\n' +
      '【対象の経済指標（前回値・予想値）】\n' + lines + '\n\n' +
      '出力は必ず次のJSONのみ（前後に説明やコードブロック記号を付けない）：\n' +
      '{\n' +
      '  "title": "記事タイトル（30〜50字程度、引きのある見出し）",\n' +
      '  "body_html": "記事本文のHTML。使用タグは <h3> <p> <ul> <li> <strong> のみ。mioの口調（ですます調・🌸を時々）。導入のあと、各指標ごとに <h3> 見出しを立て、調べたファンダの要点・ドル円とゴールドへの想定影響・方向の根拠を簡潔にまとめる。",\n' +
      '  "table_html": "各指標を1行にまとめた<table>のHTML（属性やclassは付けない）。列は「指標」「前回→予想」「ドル円」「ゴールド」「方向」。ドル円・ゴールドは上昇/下落の想定を矢印や短い言葉で、「方向」はロング/ショートの一択を入れる。"\n' +
      '}\n\n' +
      'ルール：\n' +
      '- 各指標について、ドル円とゴールドそれぞれの想定方向と、ロング/ショートの一択を必ず示すこと\n' +
      '- 一択には「結果が予想に対してどう出た場合か」を一言添えること（例：結果が予想を上回ればドル円はロング目線、など）\n' +
      '- Web検索で確認した最新の市場予想・状況を反映すること\n' +
      '- 投資助言ではなく教育・情報提供として書くこと。本文の最後に、最終的な売買判断は自己責任である旨を一言添えること\n' +
      '- ニュース原文をそのまま転載せず、要点を自分の言葉でmio口調にまとめること\n' +
      '- ディスコードやEA・商品の宣伝文は入れないこと（別途ページ側で付与します）\n' +
      '- JSON以外は一切出力しないこと';
  } else {
    // ===== 最新ニュースモード（従来）=====
    const topic = focus === 'gold' ? 'ゴールド（XAUUSD）'
      : focus === 'usdjpy' ? 'ドル円（USD/JPY）'
      : 'ドル円（USD/JPY）とゴールド（XAUUSD）';
    maxTokens = 3000;
    prompt =
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
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens,
        messages: imageContent ? [{ role: 'user', content: imageContent }] : [{ role: 'user', content: prompt }],
        ...(useWebSearch ? { tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
          user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' }
        }] } : {})
      })
    });
    const data = await res.json();
    let text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);

    // 下書きとして保存
    const ins = await fetch(SUPABASE_URL + '/rest/v1/gift_contents', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        title: parsed.title || '今日の相場分析',
        body_html: parsed.body_html || '',
        table_html: parsed.table_html || '',
        status: 'draft'
      })
    });
    if (!ins.ok) console.error('[gift-generate-bg] 下書き保存エラー:', ins.status);
    else console.log('[gift-generate-bg] 下書き保存完了');
  } catch (e) {
    console.error('[gift-generate-bg] 生成/保存エラー:', e);
  }

  return { statusCode: 200, body: 'ok' };
};
