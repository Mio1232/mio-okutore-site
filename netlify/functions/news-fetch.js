// Netlify Function: ニュース候補の自動取得 + mio風コメント生成
// Google News RSSからFX関連ニュースを取得し、Anthropic APIでコメント生成

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  try {
    // 複数のRSSフィードからニュースを取得
    const feeds = [
      { url: 'https://news.google.com/rss/search?q=%E3%83%89%E3%83%AB%E5%86%86+FX&hl=ja&gl=JP&ceid=JP:ja', category: 'us' },
      { url: 'https://news.google.com/rss/search?q=%E3%82%B4%E3%83%BC%E3%83%AB%E3%83%89+%E9%87%91%E4%BE%A1%E6%A0%BC&hl=ja&gl=JP&ceid=JP:ja', category: 'us' },
      { url: 'https://news.google.com/rss/search?q=%E7%B1%B3%E5%9B%BD%E6%A0%AA+%E5%B8%82%E6%B3%81&hl=ja&gl=JP&ceid=JP:ja', category: 'us' },
      { url: 'https://news.google.com/rss/search?q=%E6%97%A5%E9%8A%80+%E9%87%91%E5%88%A9+%E5%86%86&hl=ja&gl=JP&ceid=JP:ja', category: 'jp' },
    ];

    let allArticles = [];

    for (const feed of feeds) {
      try {
        const res = await fetch(feed.url);
        const xml = await res.text();

        // 簡易XMLパース（<item>タグから取得）
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        
        for (const item of items.slice(0, 5)) { // 各フィードから最大5件
          const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/);
          const linkMatch = item.match(/<link>(.*?)<\/link>/);
          const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
          const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);

          if (titleMatch && linkMatch) {
            const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            const url = linkMatch[1].trim();
            const source = sourceMatch ? sourceMatch[1].trim() : '';
            const pubDate = pubDateMatch ? pubDateMatch[1] : '';

            // 24時間以内の記事のみ
            if (pubDate) {
              const articleDate = new Date(pubDate);
              const now = new Date();
              const hoursDiff = (now - articleDate) / (1000 * 60 * 60);
              if (hoursDiff > 48) continue;
            }

            // 重複チェック（タイトルが似ているものを除外）
            const isDuplicate = allArticles.some(a => 
              a.title.substring(0, 20) === title.substring(0, 20)
            );
            if (!isDuplicate) {
              allArticles.push({
                title,
                url,
                source,
                category: feed.category,
                pubDate
              });
            }
          }
        }
      } catch (feedErr) {
        console.warn('Feed error:', feed.url, feedErr.message);
      }
    }

    // 最大10件に絞る
    allArticles = allArticles.slice(0, 10);

    if (allArticles.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ articles: [], message: '候補記事が見つかりませんでした' })
      };
    }

    // Anthropic APIでコメント生成 + カテゴリ判定
    const articleList = allArticles.map((a, i) => 
      `${i + 1}. タイトル: ${a.title}\n   ソース: ${a.source}`
    ).join('\n');

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        system: `あなたはFXトレーダー「美桜Mio」としてニュース記事にコメントを付けます。

ルール:
- 各記事に1〜2文の短いコメントをつける
- ドル円、ゴールド、BTC、株式市場への影響を中心に
- 優しく上品な口調（「〜ですね」「〜でしょう」）
- 絵文字は使わない
- トレーダー目線で実践的な見解
- カテゴリを判定: us(米国市況), jp(日本市況), policy(経済政策), other(その他)

以下の形式でJSONだけを返してください。前後に説明やバッククォートは不要です:
[
  {"index": 1, "comment": "コメント内容", "category": "us"},
  {"index": 2, "comment": "コメント内容", "category": "jp"}
]`,
        messages: [
          {
            role: 'user',
            content: `以下のニュース記事にmioとしてコメントとカテゴリを付けてください:\n\n${articleList}`
          }
        ]
      })
    });

    let aiComments = [];
    if (aiResponse.ok) {
      const aiData = await aiResponse.json();
      const text = (aiData.content && aiData.content[0] && aiData.content[0].text) || '[]';
      try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        aiComments = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('AI comment parse error:', parseErr.message);
      }
    }

    // 記事とコメントをマージ
    const results = allArticles.map((article, i) => {
      const aiComment = aiComments.find(c => c.index === i + 1);
      return {
        title: article.title,
        url: article.url,
        source: article.source,
        category: aiComment ? aiComment.category : article.category,
        comment: aiComment ? aiComment.comment : '',
        pubDate: article.pubDate
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ articles: results })
    };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
