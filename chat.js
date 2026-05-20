// Netlify Function: AI Chat via Dify API
// user_context(収支データ等)をDifyのinputsとして送信
// APIキーはNetlify環境変数で管理

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
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { query, user_name, user_context, conversation_id, user_id } = body;

    if (!query || !query.trim()) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'メッセージが空です' })
      };
    }

    const difyApiKey = process.env.DIFY_API_KEY;
    const difyApiUrl = process.env.DIFY_API_URL || 'https://api.dify.ai/v1';

    if (!difyApiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'DIFY_API_KEYが設定されていません' })
      };
    }

    // Dify APIにリクエスト
    // inputs にユーザー情報を渡す（Dify側で変数として参照可能）
    const response = await fetch(`${difyApiUrl}/chat-messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${difyApiKey}`
      },
      body: JSON.stringify({
        inputs: {
          user_name: user_name || '',
          user_context: user_context || ''
        },
        query: query,
        response_mode: 'blocking',
        user: user_id || 'anonymous',
        conversation_id: conversation_id || ''
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Dify API error:', response.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'AI応答エラー', detail: errText })
      };
    }

    const data = await response.json();
    let text = data.answer || '';

    // ※マーク自動削除
    text = text.replace(/\n+(\u203B|\uff0a)[^\n]*/g, '').trim();
    text = text.replace(/^(\u203B|\uff0a)[^\n]*\n+/g, '').trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text,
        conversation_id: data.conversation_id || ''
      })
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
