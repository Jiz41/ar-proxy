'use strict';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// shadow/vm_loader.js
// ─────────────────────────────────────────────────────────────────
// HF Space「Jiz41/jiz41r1t5u_RONDE」の本番ロジック（ar_ronde.js /
// ar_adapter.js / ar_shadow.js）を実行時に取得し、Node の vm サンドボックスへ
// ロードする。ロジックの二重管理を避けるため、コードは一切ローカルに複製せず
// 毎回 HF から取得する。
//
// サンドボックスには window / document / localStorage / fetch のスタブ（一部実体）を
// 構築する。ブラウザ実装（keirin-proxy-ii/orchestrator.js の vm.createContext 方式）を
// 踏襲している。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const vm = require('vm');

const HF_BASE = 'https://huggingface.co/spaces/Jiz41/jiz41r1t5u_RONDE/resolve/main';

// ━━━━━━━━━━━━━━━━━━━━━━
// HF からテキスト取得
// ─────────────────────────────────────────────
// HF は resolve/main を LFS/CDN へリダイレクトするため follow が必須（curl の -L 相当）。
// Node のグローバル fetch は既定で redirect: 'follow' だが、明示しておく。
// ━━━━━━━━━━━━━━━━━━━━━━
async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`[vm_loader] fetch失敗 ${url}: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`[vm_loader] HTTP ${res.status} ${res.statusText} ${url}`);
  }
  return res.text();
}

// index.html の <meta name="app-version" content="..."> から engine_ver を抽出
function extractAppVersion(html) {
  const m = html.match(/<meta\s+name=["']app-version["']\s+content=["']([^"']*)["']/i);
  return m ? m[1] : '';
}

// ━━━━━━━━━━━━━━━━━━━━━━
// サンドボックスをロードして公開オブジェクトを返す
// ━━━━━━━━━━━━━━━━━━━━━━
module.exports = async function loadVm() {
  // 1. engine_ver 抽出用に index.html を取得
  const indexHtml = await fetchText(`${HF_BASE}/index.html`);
  const engineVer = extractAppVersion(indexHtml);

  // 2. ロジック3ファイルを取得（依存順に後で実行する）
  const rondeSrc   = await fetchText(`${HF_BASE}/ar_ronde.js`);
  const adapterSrc = await fetchText(`${HF_BASE}/ar_adapter.js`);
  const shadowSrc  = await fetchText(`${HF_BASE}/ar_shadow.js`);

  // ── localStorage スタブ ──
  // ronde_shadow_endpoint → process.env.SHADOW_ENDPOINT
  // ronde_shadow_token    → process.env.SHADOW_TOKEN
  // 未設定なら null を返す。ar_shadow.js 側は `|| ''` で空文字化し、
  // endpoint/token いずれか空ならサイレントスキップ（＝POSTしない）。
  const localStorageStub = {
    getItem(key) {
      if (key === 'ronde_shadow_endpoint') return process.env.SHADOW_ENDPOINT || null;
      if (key === 'ronde_shadow_token')    return process.env.SHADOW_TOKEN || null;
      return null;
    },
    setItem() {},
    removeItem() {},
  };

  // ── document スタブ ──
  // querySelector('meta[name="app-version"]') は content=engineVer を持つ要素を返す。
  // それ以外の DOM 参照は無害なスタブ（null 等）を返す。
  const metaEl = { content: engineVer };
  const documentStub = {
    querySelector(sel) {
      if (typeof sel === 'string' && sel.indexOf('app-version') !== -1) return metaEl;
      return null;
    },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() {
      return {
        style: {}, innerHTML: '',
        appendChild() {}, remove() {}, setAttribute() {}, onclick: null,
      };
    },
    addEventListener() {},
    readyState: 'complete',
    body: { appendChild() {} },
  };

  // ── window スタブ ──
  // ar_shadow.js の maybeShowSetup() が window.location.search を参照するため用意する。
  const windowStub = {
    location: { search: '' },
    addEventListener() {},
  };

  // ── fetch ──
  // ar_shadow.js は fetch(..., { mode: 'no-cors' }) を指定する。ブラウザと違い
  // Node の fetch（undici）は mode を無視せず処理し、no-cors 指定だと GAS への
  // POST が永久に pending となり実際には送信されない（実測: mode 無しなら約1.5秒で
  // 200、mode 有りは15秒でも timeout）。そこで opts から mode を除去してから
  // Node の fetch へ渡すラッパーを注入し、POST が確実に GAS へ届くようにする。
  // サンドボックス内から発行された fetch の Promise を貯めておき、
  // 呼び出し側（crawl.js）が drainFetches() で完了と HTTP ステータスを確認できるようにする。
  // ar_shadow.js の record は fire-and-forget で送信成否を返さないため、ここで補う。
  const pendingFetches = [];
  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    fetch: (url, opts) => {
      const o = Object.assign({}, opts);
      delete o.mode;
      const p = fetch(url, o);
      pendingFetches.push(p);
      return p;
    },
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URLSearchParams: URLSearchParams,
  };

  const context = vm.createContext(sandbox);

  // 依存順に実行: ar_ronde.js（window.ArRonde 公開）→ ar_adapter.js（window.ArRonde 依存）
  // → ar_shadow.js（window.ArRonde / document / localStorage 依存、window.ArShadow 公開）
  try {
    vm.runInContext(rondeSrc,   context, { filename: 'ar_ronde.js' });
    vm.runInContext(adapterSrc, context, { filename: 'ar_adapter.js' });
    vm.runInContext(shadowSrc,  context, { filename: 'ar_shadow.js' });
  } catch (e) {
    throw new Error(`[vm_loader] サンドボックス実行に失敗: ${e.message}`);
  }

  const ArRonde   = windowStub.ArRonde;
  const ArAdapter = windowStub.ArAdapter;
  // 記録モジュールの公開名は実ファイル確認済み → window.ArShadow（record / showSetup）
  const ArShadow  = windowStub.ArShadow;

  if (!ArRonde || !ArAdapter || !ArShadow) {
    throw new Error(
      `[vm_loader] 公開オブジェクト欠落: ArRonde=${!!ArRonde} ArAdapter=${!!ArAdapter} ArShadow=${!!ArShadow}`
    );
  }

  // 直近に発行された fetch をすべて待ち、settled 結果の配列を返す（貯めた分はクリア）。
  async function drainFetches() {
    return Promise.allSettled(pendingFetches.splice(0));
  }

  return { window: windowStub, context, ArRonde, ArAdapter, ArShadow, engineVer, drainFetches };
};
