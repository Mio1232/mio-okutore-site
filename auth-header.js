// =================================================
// mio億トレ — 動的認証ヘッダー
// 各ページの</body>直前で読み込むだけで、
// 画面右上に「ログイン/マイページ」ボタンが表示されます
// =================================================

(async function() {
  // すでに読み込まれている場合はスキップ
  if (window.__authHeaderLoaded) return;
  window.__authHeaderLoaded = true;

  const SUPABASE_URL = 'https://iupkaxzesrximmfkipzd.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1cGtheHplc3J4aW1tZmtpcHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4MDM1NjIsImV4cCI6MjA5NDM3OTU2Mn0.jDZOxyLkSd3NcZgIKHJGOK9m8D561eqoQYbOUxtFYOQ';

  // Supabase クライアント読み込み
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ログイン状態を取得
  const { data: { session } } = await supabase.auth.getSession();
  const isLoggedIn = !!session;

  // スタイル
  const style = document.createElement('style');
  style.textContent = `
    .mio-auth-fab {
      position: fixed;
      top: 14px;
      right: 14px;
      z-index: 9998;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: opacity 0.3s ease;
      opacity: 0;
      pointer-events: none;
    }
    .mio-auth-fab.ready {
      opacity: 1;
      pointer-events: auto;
    }
    .mio-auth-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 7px 12px;
      background: rgba(255, 254, 251, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(58, 46, 42, 0.12);
      border-radius: 18px;
      font-family: 'Noto Sans JP', system-ui, sans-serif;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: #3A2E2A;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(58, 46, 42, 0.06);
    }
    .mio-auth-btn:hover {
      background: rgba(255, 254, 251, 1);
      border-color: rgba(201, 139, 149, 0.4);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(58, 46, 42, 0.1);
    }
    .mio-auth-btn-primary {
      background: #C98B95;
      color: #FFFFFF;
      border-color: #C98B95;
    }
    .mio-auth-btn-primary:hover {
      background: #B06B75;
      border-color: #B06B75;
    }
    .mio-auth-btn svg {
      width: 13px;
      height: 13px;
    }
    .mio-auth-avatar {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #E8D0D2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: 'Noto Serif JP', serif;
      font-size: 10px;
      font-weight: 600;
      color: #B06B75;
      overflow: hidden;
      flex-shrink: 0;
    }
    .mio-auth-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `;
  document.head.appendChild(style);

  // ヘッダー要素を作成
  const container = document.createElement('div');
  container.className = 'mio-auth-fab';

  if (isLoggedIn) {
    // ログイン中:マイページボタン
    const user = session.user;
    
    // プロフィール取得(表示名・アバター)
    let displayName = user.email.split('@')[0];
    let avatarUrl = null;
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name, avatar_url')
        .eq('id', user.id)
        .single();
      if (profile?.display_name) displayName = profile.display_name;
      if (profile?.avatar_url) avatarUrl = profile.avatar_url;
    } catch (e) {
      // プロフィール取得失敗時はメールから生成
    }

    const initial = displayName.charAt(0).toUpperCase();
    const avatarHTML = avatarUrl 
      ? `<span class="mio-auth-avatar"><img src="${avatarUrl}" alt=""></span>`
      : `<span class="mio-auth-avatar">${initial}</span>`;

    container.innerHTML = `
      <a class="mio-auth-btn" href="dashboard.html">
        ${avatarHTML}
        <span>マイページ</span>
      </a>
    `;
  } else {
    // 未ログイン:ログイン・新規登録ボタン
    container.innerHTML = `
      <a class="mio-auth-btn" href="login.html">
        ログイン
      </a>
      <a class="mio-auth-btn mio-auth-btn-primary" href="register.html">
        新規登録
      </a>
    `;
  }

  // 追加
  document.body.appendChild(container);
  
  // 表示アニメーション
  setTimeout(() => {
    container.classList.add('ready');
  }, 100);
})();
