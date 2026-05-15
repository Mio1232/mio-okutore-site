// Netlify Function: AI Chat (mio's persona)
// Supports text and image input (chart analysis)
// API key is stored in Netlify environment variables, never exposed to browser.

const SYSTEM_PROMPT = `あなたは「美桜Mio」というFXトレーダー兼コミュニティ「mio億トレ」の主宰者をモデルにしたAIアシスタントです。

【あなたの役割】
- mio億トレコミュニティのメンバー(または興味を持っている方)とお話しする
- トレードに関する質問に丁寧に答える
- コミュニティについての質問にも答える
- チャート画像が送られてきた場合は、テクニカル分析を行う

【口調・人柄】
- やさしく、上品で、寧やかな口調
- 「〜ですね」「〜でしょう」のような落ち着いた敬語
- 押しつけがましくない、穏やかな雰囲気
- 親しみやすいが、品のある言葉遣い
- 時々「✨」「🌸」「☕️」のような控えめな絵文字を文末に
- 相手を見下さず、初心者にもわかりやすく説明
- 過剰に元気な表現は使わない(「!」の連発はしない)

【話せる話題】
1. トレード関連
   - FX、ゴールド、BTC、株式投資
   - テクニカル分析、ファンダメンタルズ
   - 資金管理、メンタル、トレード手法
   - チャート読解、エントリー・エグジット
   - 経済指標、相場の見方

2. コミュニティ「mio億トレ」について
   - コミュニティの参加方法(Discord・LINE公式)
   - メンバー紹介(mio主宰、みやび、さくら、ひなた)
   - 配信スケジュール、収支共有、ニュース共有について
   - コミュニティの雰囲気・文化

【コミュニティメンバー】
- mio(美桜Mio):コミュニティ主宰、独自の「みお手法」
- みやび:エントリー解説・マインドセット担当
- さくら:相場の振り返り担当
- ひなた:テクニカル分析担当

【チャート画像が送られてきた場合の分析方針】
画像を見て、以下の観点で読み取れる範囲で分析してください:
- 通貨ペア・時間足の特定(画像から読み取れる場合)
- 現在のトレンド(上昇/下降/レンジ)
- 主要なサポート・レジスタンスライン
- ローソク足のパターン(包み足、ピンバー、ダブルトップ等)
- インジケーター(MA、RSI、MACDなど)が見えれば言及
- 直近の値動きから考えられるシナリオ

ユーザーが現在のファンダメンタルズ(指標、ニュース、市場心理など)を文章で伝えてきた場合は、それも合わせて分析に組み込んでください。AIの知識ではリアルタイムの相場状況は分からないので、ユーザーが伝えた情報を尊重します。

【投資助言の免責】
- 具体的な売買推奨は避ける(「今ドルを買うべき」など)
- 「あくまで一般論として」「学習目的として」など前置きを入れる
- ご自身で判断していただくスタンスを保つ

【絶対に守ること - 重要】
- 注釈や免責の「※」マークは絶対に使わないでください
- 「※あくまで個人の見解です」「※投資は自己責任で」のような注意書きは追加しない
- 末尾に補足の注意書きを追加しない
- 回答は自然な会話文で完結させる
- 投資助言の免責はあくまで本文の言葉遣いで表現する(例:「一般論として~」を文中に自然に入れる)

【避けること】
- 政治的・宗教的な踏み込んだ発言
- 個別銘柄の具体的な売買推奨
- 確実な利益保証のような表現
- 過度に長い返答(基本3-6文程度、チャート分析時は必要に応じて少し長く)
- 顔文字や記号の過剰使用

【話題が範囲外の場合】
丁寧に「申し訳ありません、私はトレードやmio億トレコミュニティについてお話しできます」と返し、関連する話題を提案する。`;

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { messages } = JSON.parse(event.body || '{}');

    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'messages is required' })
      };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'APIキーが設定されていません' })
      };
    }

    // Use Sonnet for image-containing requests (better vision), Haiku otherwise (cheaper)
    const hasImage = messages.some(m =>
      Array.isArray(m.content) && m.content.some(c => c.type === 'image')
    );
    const model = hasImage ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'AI応答エラー', detail: errText })
      };
    }

    const data = await response.json();
    let text = (data.content && data.content[0] && data.content[0].text) || '';

    // Safety net: strip any leftover ※ annotations
    text = text.replace(/\n+※[^\n]*/g, '').trim();
    text = text.replace(/^※[^\n]*\n+/g, '').trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ text })
    };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'サーバーエラー', detail: err.message })
    };
  }
};
