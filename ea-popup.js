// ea-popup.js
// EA訴求ポップアップ（全ページ共通）。
// 使い方: 出したいページの </body> の直前に次の1行を追加するだけ。
//   <script type="module" src="/ea-popup.js"></script>
// ログインしていないページでは何もしません（安全に無視）。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ===== 設定: 必要に応じてここだけ調整 =====
const SUPABASE_URL = 'https://iupkaxzesrximmfkipzd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1cGtheHplc3J4aW1tZmtpcHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4MDM1NjIsImV4cCI6MjA5NDM3OTU2Mn0.jDZOxyLkSd3NcZgIKHJGOK9m8D561eqoQYbOUxtFYOQ';

const LP_URL = 'https://miyabiealp.netlify.app/';
const IMG = {
  streak:  '/ea-popup-streak.jpg',   // 3連敗（共感）
  monthly: '/ea-popup-monthly.jpg',  // 月間マイナス（実績）
  welcome: '/ea-popup-welcome.jpg'   // 初回2週間（安心）
};
const DISCORD_TOKEN = 'discord';                       // community_status に含まれていれば Discord 参加
const EA_TOOL_VALUES = ['miyabi_perm', 'all_system'];  // これらを持つ人にはEA訴求しない
const LIMITS = { streak: 5, monthly: 1, welcome: 1 };  // その月の表示上限
const GLOBAL_COOLDOWN_HOURS = 24;                      // 直近この時間に表示済みなら出さない
const SESSION_KEY = 'eaPopupShown';                    // 同一セッションでの多重表示を防ぐ
const USD_TO_JPY = 159;
// =========================================

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

run().catch(e => console.error('[ea-popup]', e));

async function run() {
  injectStyles();

  // テスト用: ?eapopup=streak / monthly / welcome で条件を無視して強制表示
  const forced = new URLSearchParams(location.search).get('eapopup');
  if (forced && IMG[forced]) { showPopup(forced); return; }

  // 同一セッションで既に表示していれば出さない（ページ遷移のたびに出るのを防ぐ）
  try { if (sessionStorage.getItem(SESSION_KEY)) return; } catch (_) {}

  // ログイン確認（未ログインなら何もしない＝どのページに置いても安全）
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const user = session.user;

  // プロフィール
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (!profile) return;
  if (profile.ea_popup_optout) return;                                   // 手動オプトアウト（管理用）
  const tools = Array.isArray(profile.tools_used) ? profile.tools_used : [];
  if (tools.some(t => EA_TOOL_VALUES.includes(t))) return;               // みやびEA使用中
  if (!isDiscordMember(profile.community_status)) return;                // Discord未参加

  // 表示ログ（頻度判定）
  const { data: logs } = await supabase.from('ea_popup_log').select('condition, shown_at').eq('user_id', user.id);
  const safeLogs = logs || [];
  const nowT = Date.now();
  if (safeLogs.some(l => (nowT - new Date(l.shown_at).getTime()) < GLOBAL_COOLDOWN_HOURS * 3600e3)) return;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthCount = c => safeLogs.filter(l => l.condition === c && new Date(l.shown_at).getTime() >= monthStart).length;
  const everCount  = c => safeLogs.filter(l => l.condition === c).length;

  let chosen = null;
  if (await isLosingStreak(user, now) && monthCount('streak') < LIMITS.streak) chosen = 'streak';
  else if (await isMonthlyLoss(user, now) && monthCount('monthly') < LIMITS.monthly) chosen = 'monthly';
  else if (isFirstTwoWeeks(profile, now) && everCount('welcome') < LIMITS.welcome) chosen = 'welcome';
  if (!chosen) return;

  try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (_) {}
  showPopup(chosen);
  await supabase.from('ea_popup_log').insert({ user_id: user.id, condition: chosen });
}

function isDiscordMember(cs) {
  if (!cs) return false;
  return cs.toLowerCase().split(',').map(s => s.trim()).includes(DISCORD_TOKEN);
}

// 3連敗: 直近の取引日3日が全てマイナス収支
async function isLosingStreak(user, now) {
  const since = new Date(now.getTime() - 14 * 24 * 3600e3).toISOString().split('T')[0];
  const { data: rows } = await supabase
    .from('trades').select('trade_date, profit_loss, currency')
    .eq('user_id', user.id).gte('trade_date', since)
    .order('trade_date', { ascending: false });
  if (!rows || rows.length === 0) return false;
  const byDay = {};
  rows.forEach(t => {
    const jpy = (t.currency === 'USD') ? t.profit_loss * USD_TO_JPY : t.profit_loss;
    byDay[t.trade_date] = (byDay[t.trade_date] || 0) + jpy;
  });
  const days = Object.keys(byDay).sort().reverse();
  if (days.length < 3) return false;
  return days.slice(0, 3).every(d => byDay[d] < 0);
}

// 月間マイナス（25日以降）
async function isMonthlyLoss(user, now) {
  if (now.getDate() < 25) return false;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const { data: rows } = await supabase
    .from('trades').select('profit_loss, currency')
    .eq('user_id', user.id).gte('trade_date', startOfMonth);
  if (!rows || rows.length === 0) return false;
  const total = rows.reduce((s, t) => s + ((t.currency === 'USD') ? t.profit_loss * USD_TO_JPY : t.profit_loss), 0);
  return total < 0;
}

// 初回登録から2週間経過
function isFirstTwoWeeks(profile, now) {
  if (!profile.created_at) return false;
  return (now.getTime() - new Date(profile.created_at).getTime()) >= 14 * 24 * 3600e3;
}

function showPopup(cond) {
  const overlay = document.createElement('div');
  overlay.className = 'ea-popup-overlay';
  overlay.innerHTML = `
    <div class="ea-popup">
      <button class="ea-popup-close" aria-label="閉じる">✕</button>
      <a class="ea-popup-img" href="${LP_URL}" target="_blank" rel="noopener">
        <img src="${IMG[cond]}" alt="みやびEAのご案内">
      </a>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.ea-popup-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.ea-popup-img').addEventListener('click', () => setTimeout(close, 50));
}

function injectStyles() {
  if (document.getElementById('ea-popup-styles')) return;
  const css = `
.ea-popup-overlay{position:fixed;inset:0;background:rgba(58,46,42,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;animation:eaFade .2s ease;}
.ea-popup{position:relative;width:100%;max-width:360px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);animation:eaPop .25s ease;}
.ea-popup-close{position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-size:15px;line-height:1;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center;}
.ea-popup-img{display:block;cursor:pointer;}
.ea-popup-img img{display:block;width:100%;height:auto;}
@keyframes eaFade{from{opacity:0}to{opacity:1}}
@keyframes eaPop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}`;
  const s = document.createElement('style');
  s.id = 'ea-popup-styles';
  s.textContent = css;
  document.head.appendChild(s);
}
