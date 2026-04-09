'use strict';

// ─── ZIP / xlsx パーサー ───────────────────────────────────────────────────

/**
 * ArrayBuffer として読み込んだ xlsx ファイルを解析し、
 * シート1の内容を 2次元配列で返す。
 * 外部ライブラリ不要（ZIP + XML を Web API で処理）。
 */
async function parseXlsx(arrayBuffer) {
  const buf  = arrayBuffer;
  const view = new DataView(buf);

  // ── ZIP: End of Central Directory を末尾から探す ──
  let eocd = -1;
  const maxSearch = Math.min(65558, view.byteLength);
  for (let i = view.byteLength - 22; i >= view.byteLength - maxSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP として認識できません');

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdSize   = view.getUint32(eocd + 12, true);

  // ── ZIP: セントラルディレクトリをパース ──
  const entries = new Map();
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method      = view.getUint16(pos + 10, true);
    const compSize    = view.getUint32(pos + 20, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, pos + 46, nameLen));
    entries.set(name, { method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // ── ZIP: エントリの生データを取得 ──
  async function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const lh = entry.localOffset;
    if (view.getUint32(lh, true) !== 0x04034b50) return null;
    const lhNameLen  = view.getUint16(lh + 26, true);
    const lhExtraLen = view.getUint16(lh + 28, true);
    const data = new Uint8Array(buf, lh + 30 + lhNameLen + lhExtraLen, entry.compSize);

    if (entry.method === 0) {                       // 無圧縮
      return new TextDecoder().decode(data);
    }
    if (entry.method === 8) {                       // DEFLATE
      const ds     = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data);
      writer.close();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let i = 0;
      for (const c of chunks) { out.set(c, i); i += c.length; }
      return new TextDecoder().decode(out);
    }
    return null;
  }

  // ── xlsx: 共有文字列テーブル ──
  const ssXml = await readEntry('xl/sharedStrings.xml');
  const strs  = [];
  if (ssXml) {
    const doc = new DOMParser().parseFromString(ssXml, 'application/xml');
    for (const si of doc.getElementsByTagName('si')) {
      strs.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    }
  }

  // ── xlsx: シート1 ──
  const wsXml = await readEntry('xl/worksheets/sheet1.xml');
  if (!wsXml) throw new Error('シートが見つかりません');
  const wsDoc = new DOMParser().parseFromString(wsXml, 'application/xml');

  function cellVal(c) {
    const t = c.getAttribute('t');
    const v = c.getElementsByTagName('v')[0];
    if (!v) return '';
    return t === 's' ? (strs[+v.textContent] ?? '') : v.textContent;
  }

  // セル参照（"B3" など）→ 0始まり列インデックス
  function colOf(ref) {
    const m = ref.match(/^([A-Z]+)/);
    if (!m) return 0;
    return m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  }

  const rows = [];
  for (const row of wsDoc.getElementsByTagName('row')) {
    const cells = [...row.getElementsByTagName('c')];
    if (cells.length === 0) continue;
    const arr = [];
    for (const c of cells) {
      const col = colOf(c.getAttribute('r') ?? '');
      while (arr.length <= col) arr.push('');
      arr[col] = cellVal(c);
    }
    rows.push(arr);
  }

  return rows;
}

// ─── カラム自動検出 ───────────────────────────────────────────────────────

function detectColumns() {
  return { codeCol: 0, roomCol: 7, noteCol: 10 }; // A列=科目番号、H列=授業教室、K列=備考
}

// 各形式の判定は「特徴的なキーワード」で行う（括弧の種類・表記ゆれに強い）
const FORMAT_MATCHERS = [
  { label: '対面（オンライン併用型）',    test: s => /対面/.test(s) && /オンライン/.test(s) },
  { label: 'オンライン（対面併用型）',    test: s => /オンライン/.test(s) && /対面/.test(s) },
  { label: 'オンライン（オンデマンド型）', test: s => /オンデマンド/.test(s) },
  { label: 'オンライン（同時双方向型）',  test: s => /双方向/.test(s) },
  { label: '対面',                        test: s => /対面/.test(s) },
];

function extractFormat(note) {
  const n = note.normalize('NFC');
  for (const { label, test } of FORMAT_MATCHERS) {
    if (test(n)) return label;
  }
  return '';
}

// ─── ストレージ ───────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
function storageRemove(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// ─── UI ──────────────────────────────────────────────────────────────────

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function refreshStatus() {
  const { kdbMeta } = await storageGet('kdbMeta');
  const statusText   = document.getElementById('statusText');
  const statusDetail = document.getElementById('statusDetail');
  const clearBtn     = document.getElementById('clearBtn');

  if (kdbMeta) {
    const date = new Date(kdbMeta.importedAt).toLocaleDateString('ja-JP');
    statusText.textContent  = `✓ ${kdbMeta.count.toLocaleString()} 件取り込み済み`;
    statusText.className    = 'status-ok';
    statusDetail.textContent = `更新: ${date}`;
    clearBtn.style.display  = '';
  } else {
    statusText.textContent  = '未取り込み';
    statusText.className    = 'status-none';
    statusDetail.textContent = '';
    clearBtn.style.display  = 'none';
  }
}

// ─── メイン処理 ───────────────────────────────────────────────────────────

let parsedRows = null;

document.getElementById('xlsxInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('mappingSection').classList.remove('visible');

  let rows;
  try {
    const buf = await file.arrayBuffer();
    rows = await parseXlsx(buf);
  } catch (err) {
    showToast(`読み込みエラー: ${err.message}`);
    return;
  }

  if (rows.length < 7) {
    showToast('データが見つかりません（6行目以降にデータが必要です）');
    return;
  }

  parsedRows = rows;
  document.getElementById('mappingSection').classList.add('visible');
});

// 取り込みボタン
document.getElementById('importBtn').addEventListener('click', async () => {
  if (!parsedRows) return;

  const { codeCol, roomCol, noteCol } = detectColumns();
  const classrooms = {};
  for (const row of parsedRows.slice(5)) {        // 1〜5行目はヘッダー
    const code   = (row[codeCol] ?? '').trim();
    const room   = (row[roomCol] ?? '').trim();
    const format = extractFormat(row[noteCol] ?? '');
    if (code && (room || format)) classrooms[code] = { room, format };
  }

  const count = Object.keys(classrooms).length;
  if (count === 0) {
    showToast('教室データが見つかりませんでした。列の設定を確認してください');
    return;
  }

  const btn = document.getElementById('importBtn');
  btn.disabled   = true;
  btn.textContent = '保存中…';

  await storageSet({
    kdbData: classrooms,
    kdbMeta: { count, importedAt: new Date().toISOString() },
  });

  btn.disabled   = false;
  btn.textContent = '取り込む';
  await refreshStatus();
  showToast(`${count.toLocaleString()} 件取り込みました`);
});

// 削除ボタン
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('取り込み済みの教室データを削除しますか？')) return;
  await storageRemove(['kdbData', 'kdbMeta']);
  await refreshStatus();
  showToast('削除しました');
});

// 初期表示
refreshStatus();
