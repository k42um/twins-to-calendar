'use strict';

// ─── 定数 ──────────────────────────────────────────────────────────────────

const DAY_NAMES = { 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土', 7: '日' };

// TWINS の曜日番号 → JavaScript の getDay() (0=日)
const TWINS_DAY_TO_JS = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0 };

// 振替設定の曜日名 → TWINS 曜日番号
const DAY_NAME_TO_TWINS = { '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6, '日': 7 };

// 筑波大学の時限定義（JST）
const PERIOD_TIMES = {
  1: { start: '08:40', end: '09:55' },
  2: { start: '10:10', end: '11:25' },
  3: { start: '12:15', end: '13:30' },
  4: { start: '13:45', end: '15:00' },
  5: { start: '15:15', end: '16:30' },
  6: { start: '16:45', end: '18:00' },
  7: { start: '18:15', end: '19:30' },
};

// ─── カレンダー設定の読み込み ──────────────────────────────────────────────

/**
 * 'YYYY-MM-DD' または 'YYYY-MM-DD..YYYY-MM-DD' 形式の配列を
 * 'YYYY-MM-DD' の平坦な配列に展開する。
 */
function expandHolidays(raw) {
  const result = [];
  for (const entry of raw) {
    if (entry.includes('..')) {
      const [startStr, endStr] = entry.split('..');
      const d = parseDate(startStr);
      const end = parseDate(endStr);
      if (d > end) continue; // 逆順記述はスキップ
      while (d <= end) {
        result.push(formatDate(d));
        d.setDate(d.getDate() + 1);
      }
    } else {
      result.push(entry);
    }
  }
  return result;
}

/**
 * substitutes を配列形式に正規化する。
 * 入力は以下のどちらでも受け付ける:
 *   オブジェクト形式（新）: { "2026-09-22": "月" } または { "2026-09-22": { follows: "月", note: "..." } }
 *   配列形式（旧）:          [{ date: "2026-09-22", follows: "月", note: "..." }]
 */
function normalizeSubstitutes(raw) {
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([date, val]) => ({
    date,
    follows: typeof val === 'string' ? val : val.follows,
    note:    typeof val === 'string' ? ''  : (val.note || ''),
  }));
}

/** JSON を読み込んで holidays 展開・substitutes 正規化を行う */
function normalizeCalendar(raw) {
  return {
    terms:       raw.terms || {},
    holidays:    expandHolidays(raw.holidays || []),
    substitutes: normalizeSubstitutes(raw.substitutes || {}),
  };
}

/**
 * calendars/${year}.json を読み込む。
 * ファイルが存在しない場合は空のカレンダーを返す。
 */
async function loadCalendar(year) {
  try {
    const url = chrome.runtime.getURL(`calendars/${year}.json`);
    const res = await fetch(url);
    if (!res.ok) return normalizeCalendar({});
    return normalizeCalendar(await res.json());
  } catch {
    return normalizeCalendar({});
  }
}

// ─── TWINS ページのパース（content script として注入）────────────────────────

function extractCoursesFromPage() {
  const result = { year: null, term: null, courses: [] };

  // 選択中のタームタブを検出
  const selTab = document.querySelector('.rishu-tab-sel');
  if (selTab) {
    result.term = selTab.textContent.trim();
  }

  // 年度を検出（「2026年度　春A」のようなテキストから）
  const allTds = document.querySelectorAll('td');
  for (const td of allTds) {
    const m = td.textContent.trim().match(/^(\d{4})年度/);
    if (m) {
      result.year = parseInt(m[1], 10);
      break;
    }
  }

  // 登録済み科目のリンクを収集
  // onclick="return DeleteCallA('year','25','courseCode','day','period')"
  const seen = new Set();
  const links = document.querySelectorAll('a[onclick*="DeleteCallA"]');

  for (const link of links) {
    const onclick = link.getAttribute('onclick') || '';
    const m = onclick.match(/DeleteCallA\('(\d+)','[^']*','([^']+)','(\d+)','(\d+)'\)/);
    if (!m) continue;

    const courseCode = m[2];
    const day        = parseInt(m[3], 10);
    const period     = parseInt(m[4], 10);

    // 集中講義は曜日・時限が定まらないため除外
    if (day < 1 || day > 7 || period < 1 || period > 7) continue;

    const key = `${courseCode}|${day}|${period}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 科目名・担当者名は <a> の兄弟テキストノードから取得
    const td = link.closest('td');
    if (!td) continue;

    const texts = [];
    for (const node of td.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) texts.push(t);
      }
    }

    result.courses.push({
      courseCode,
      name:       texts[0] || courseCode,
      instructor: texts[1] || '',
      day,
      period,
    });
  }

  return result;
}

// ─── 科目スロットの結合（同科目・同曜日で連続する時限をまとめる）──────────────

function groupCourseSlots(slots) {
  const groups = {};
  for (const slot of slots) {
    const key = `${slot.courseCode}|${slot.day}`;
    if (!groups[key]) {
      groups[key] = { ...slot, periods: [slot.period] };
    } else {
      groups[key].periods.push(slot.period);
    }
  }

  return Object.values(groups).map(g => {
    g.periods.sort((a, b) => a - b);
    const blocks = [];
    let block = [g.periods[0]];
    for (let i = 1; i < g.periods.length; i++) {
      if (g.periods[i] === g.periods[i - 1] + 1) {
        block.push(g.periods[i]);
      } else {
        blocks.push(block);
        block = [g.periods[i]];
      }
    }
    blocks.push(block);
    return blocks.map(b => ({
      courseCode: g.courseCode,
      name:       g.name,
      instructor: g.instructor,
      day:        g.day,
      periodStart: b[0],
      periodEnd:   b[b.length - 1],
    }));
  }).flat();
}

// ─── 日付ユーティリティ ────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → Date (ローカル深夜0時) */
function parseDate(str) {
  const [y, mo, d] = str.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

/** Date → 'YYYY-MM-DD' */
function formatDate(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** 'HH:MM' → { h, m } */
function parseTime(str) {
  const [h, m] = str.split(':').map(Number);
  return { h, m };
}

/** termStart 以降で最初に jsDay（0=日〜6=土）となる日付を返す */
function firstOccurrence(termStart, jsDay) {
  const d = new Date(termStart);
  const diff = ((jsDay - d.getDay()) + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d;
}

// ─── ICS 生成 ──────────────────────────────────────────────────────────────

function generateUID() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@twins-to-calendar`;
}

function makeICSDatetime(date, timeStr) {
  const { h, m } = parseTime(timeStr);
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${y}${mo}${d}T${hh}${mm}00`;
}

/** ICS の UNTIL 値（UTC）: termEnd の JST 23:59:59 = UTC 14:59:59 */
function makeUntilUTC(termEnd) {
  const [y, mo, d] = termEnd.split('-');
  return `${y}${mo}${d}T145959Z`;
}

/**
 * ICS を生成する。
 * @param {Array}  courses   - groupCourseSlots() の出力
 * @param {string} termStart - 'YYYY-MM-DD'
 * @param {string} termEnd   - 'YYYY-MM-DD'
 * @param {string} termLabel - 例 '2026年度 春A'
 * @param {Object} calendar    - normalizeCalendar() 済みのカレンダーデータ
 * @param {Object} classrooms  - { courseCode: classroom } の教室マップ（省略可）
 */
function generateICS(courses, termStart, termEnd, termLabel, calendar, classrooms = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TWINS to Calendar//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + termLabel + ' 時間割',
    'X-WR-TIMEZONE:Asia/Tokyo',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Tokyo',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0900',
    'TZOFFSETTO:+0900',
    'TZNAME:JST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  const startDate = parseDate(termStart);
  const endDate   = parseDate(termEnd);
  const untilStr  = makeUntilUTC(termEnd);

  const now = new Date();
  const dtstamp = makeICSDatetime(now,
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  );

  // ターム内の祝日・振替授業日を絞り込む
  const holidays = calendar.holidays.filter(d => {
    const dd = parseDate(d);
    return dd >= startDate && dd <= endDate;
  });

  const substitutes = calendar.substitutes.filter(s => {
    const dd = parseDate(s.date);
    return dd >= startDate && dd <= endDate;
  });

  for (const course of courses) {
    const jsDay    = TWINS_DAY_TO_JS[course.day];
    const firstDay = firstOccurrence(startDate, jsDay);
    if (firstDay > endDate) continue;

    const startTime = PERIOD_TIMES[course.periodStart];
    const endTime   = PERIOD_TIMES[course.periodEnd];
    if (!startTime || !endTime) continue;

    const dtstart = makeICSDatetime(firstDay, startTime.start);
    const dtend   = makeICSDatetime(firstDay, endTime.end);

    const pLabel = course.periodStart === course.periodEnd
      ? `${course.periodStart}限`
      : `${course.periodStart}〜${course.periodEnd}限`;

    const kdb    = classrooms[course.courseCode];
    const room   = kdb?.room   || '';
    const format = kdb?.format || '';

    const summary     = course.name;
    const description = course.instructor;

    // ── 通常の週次イベント ──
    const eventLines = [
      'BEGIN:VEVENT',
      `UID:${generateUID()}`,
      `DTSTAMP:${dtstamp}Z`,
      `DTSTART;TZID=Asia/Tokyo:${dtstart}`,
      `DTEND;TZID=Asia/Tokyo:${dtend}`,
      `RRULE:FREQ=WEEKLY;UNTIL=${untilStr}`,
    ];

    // 祝日が同曜日に当たる日を EXDATE で除外
    const exdates = holidays
      .filter(h => parseDate(h).getDay() === jsDay)
      .map(h => makeICSDatetime(parseDate(h), startTime.start));

    // 振替日（その日の本来の曜日が置き換えられる）も EXDATE で除外
    // 例: 4/30（木）が水曜扱い → 木曜の授業は4/30に開催されない
    const subExdates = substitutes
      .filter(s => parseDate(s.date).getDay() === jsDay)
      .map(s => makeICSDatetime(parseDate(s.date), startTime.start));

    const allExdates = [...exdates, ...subExdates];
    if (allExdates.length > 0) {
      eventLines.push(`EXDATE;TZID=Asia/Tokyo:${allExdates.join(',')}`);
    }

    const location = room || format;
    if (location) eventLines.push(`LOCATION:${location}`);

    eventLines.push(`SUMMARY:${summary}`, `DESCRIPTION:${description}`, 'END:VEVENT');
    lines.push(...eventLines);

    // ── 振替授業日の追加イベント ──
    // この科目の曜日が follows に一致する振替日に1回限りのイベントを追加する
    for (const sub of substitutes) {
      if (DAY_NAME_TO_TWINS[sub.follows] !== course.day) continue;

      const subDate   = parseDate(sub.date);
      const subStart  = makeICSDatetime(subDate, startTime.start);
      const subEnd    = makeICSDatetime(subDate, endTime.end);
      const subNote   = sub.note ? `\\n\\n振替: ${sub.note}` : `\\n\\n振替日 (${sub.date})`;

      const subLines = [
        'BEGIN:VEVENT',
        `UID:${generateUID()}`,
        `DTSTAMP:${dtstamp}Z`,
        `DTSTART;TZID=Asia/Tokyo:${subStart}`,
        `DTEND;TZID=Asia/Tokyo:${subEnd}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${description + subNote}`,
      ];
      if (location) subLines.push(`LOCATION:${location}`);
      subLines.push('END:VEVENT');
      lines.push(...subLines);
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ─── ICS ダウンロード ─────────────────────────────────────────────────────

function downloadICS(content, filename) {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── ターム日程取得（ストレージ優先、なければ JSON デフォルト）──────────────

function chromeStorageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, r => resolve(r[key] ?? null)));
}

function chromeStorageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

async function getTermDates(year, term, calendar) {
  // 1. ユーザーがポップアップで編集した値（ストレージ優先）
  const stored = await chromeStorageGet(`termDates_${year}_${term}`);
  if (stored) return stored;

  // 2. calendars/${year}.json のデフォルト値（年度ネストなし）
  return calendar.terms[term] ?? null;
}

async function saveTermDates(year, term, dates) {
  await chromeStorageSet({ [`termDates_${year}_${term}`]: dates });
}

async function clearTermDates(year, term) {
  return new Promise(resolve =>
    chrome.storage.local.remove(`termDates_${year}_${term}`, resolve)
  );
}

// ─── UI 構築 ──────────────────────────────────────────────────────────────

function renderError(message) {
  document.getElementById('termBadge').textContent = 'エラー';
  document.getElementById('app').innerHTML = `
    <div class="error-state">
      <div style="font-size:20px;margin-bottom:8px">⚠️</div>
      ${message}
    </div>
  `;
}

function renderNotOnTwins() {
  document.getElementById('termBadge').textContent = '未検出';
  document.getElementById('app').innerHTML = `
    <div class="empty-state">
      <div style="font-size:20px;margin-bottom:8px">📅</div>
      TWINSの<strong>履修登録・登録状況照会</strong>ページを開いてください。<br><br>
      <span style="font-size:11px;color:#aaa">https://twins.tsukuba.ac.jp/</span>
    </div>
  `;
}

async function renderCourses(data, calendar, year, classrooms) {
  const { term, courses: rawSlots } = data;

  if (!year || !term) {
    renderError('年度・タームを検出できませんでした。<br>履修登録ページで再度お試しください。');
    return;
  }

  const termLabel        = `${year}年度 ${term}`;
  const calendarFilename = `calendars/${year}.json`;
  document.getElementById('termBadge').textContent = termLabel;

  const courses          = groupCourseSlots(rawSlots);
  const dates            = await getTermDates(year, term, calendar);
  const isStorageOverride = !!(await chromeStorageGet(`termDates_${year}_${term}`));
  const isFromJson        = !isStorageOverride && !!calendar.terms[term];
  const noCourses         = courses.length === 0;

  // 授業形態フィルター用: 登録科目に含まれる形態の一覧
  const uniqueFormats = [...new Set(courses.map(c => classrooms[c.courseCode]?.format || ''))];
  const hasFormatData = uniqueFormats.some(f => f !== '');

  const dateSourceLabel = isStorageOverride
    ? '（手動設定）'
    : isFromJson
      ? `（${calendarFilename}）`
      : `<span style="color:#c62828">（未設定）</span>`;

  document.getElementById('app').innerHTML = `
    <div class="section">
      <div class="section-title">
        ターム期間
        <span class="date-source">${dateSourceLabel}</span>
      </div>
      ${dates
        ? renderDateInputs(dates, isStorageOverride)
        : `<div class="date-warning">
             <code>${calendarFilename}</code> にこの年度・タームの日程が登録されていません。<br>
             下の日付を入力してください。
             <div style="margin-top:8px">${renderDateInputs(
               { start: `${year}-04-06`, end: `${year}-05-14` }, false
             )}</div>
           </div>`
      }
    </div>
    ${noCourses
      ? `<div class="empty-state">登録済みの科目が見つかりませんでした。</div>`
      : `<div class="section" id="coursesSection">
           <div class="section-title">
             登録科目 <span class="count-badge">${courses.length}</span>
           </div>
           <button id="selectAll">すべて選択 / 解除</button>
           <div class="course-list" id="courseList">
             ${courses.map((c, i) => renderCourseItem(c, i, classrooms)).join('')}
           </div>
         </div>`
    }
    ${hasFormatData ? `
    <div class="section">
      <div class="section-title">授業形態で絞り込み</div>
      <div id="formatFilters">
        ${uniqueFormats.map(f => `
          <label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;cursor:pointer;">
            <input type="checkbox" checked data-format="${escapeHtml(f)}">
            ${f ? escapeHtml(f) : '（形式未設定）'}
          </label>
        `).join('')}
      </div>
    </div>
    ` : ''}
    <div class="actions">
      <button class="btn btn-primary" id="downloadBtn" ${noCourses ? 'disabled' : ''}>
        📥 ICSをダウンロード
      </button>
    </div>
    <button class="howto-toggle" id="howtoToggle">
      カレンダーへの取り込み方
      <span class="arrow">▼</span>
    </button>
    <div class="howto-section" id="howtoSection">

      <div class="howto-service">
        <div class="service-icon">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="7" fill="white" stroke="#dadce0" stroke-width="1.5"/>
            <rect x="0" y="0" width="36" height="13" rx="7" fill="#1a73e8"/>
            <rect x="0" y="7" width="36" height="6" fill="#1a73e8"/>
            <rect x="9" y="2" width="3" height="8" rx="1.5" fill="white"/>
            <rect x="24" y="2" width="3" height="8" rx="1.5" fill="white"/>
            <text x="18" y="28" text-anchor="middle" font-size="12" font-weight="800" fill="#1a73e8" font-family="Arial,sans-serif">31</text>
          </svg>
        </div>
        <div class="service-body">
          <div class="service-name">Google カレンダー</div>
          <ol class="steps">
            <li>ICSファイルをダウンロード</li>
            <li><code>calendar.google.com</code> を開く</li>
            <li>設定（⚙️）→「インポート」→ファイルを選んで取り込む</li>
          </ol>
        </div>
      </div>

      <div class="howto-service">
        <div class="service-icon">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="7" fill="white" stroke="#e0e0e0" stroke-width="1.5"/>
            <rect x="0" y="0" width="36" height="12" rx="7" fill="#FF3B30"/>
            <rect x="0" y="6" width="36" height="6" fill="#FF3B30"/>
            <text x="18" y="28" text-anchor="middle" font-size="12" font-weight="800" fill="#1C1C1E" font-family="Arial,sans-serif">31</text>
            <text x="18" y="18" text-anchor="middle" font-size="7" font-weight="600" fill="#FF3B30" font-family="Arial,sans-serif">日月火水木金土</text>
          </svg>
        </div>
        <div class="service-body">
          <div class="service-name">Apple カレンダー（Mac）</div>
          <ol class="steps">
            <li>ICSファイルをダウンロード</li>
            <li>ファイルをダブルクリック（またはカレンダー.appにドラッグ）</li>
          </ol>
          <div style="font-size:10px;color:#999;margin-top:4px">iPhone / iPad は Mac 経由、または iCloud.com で読み込み</div>
        </div>
      </div>

      <div class="howto-service">
        <div class="service-icon">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="7" fill="#0078D4"/>
            <rect x="5" y="10" width="26" height="19" rx="2" fill="white"/>
            <rect x="5" y="10" width="26" height="7" fill="#106EBE"/>
            <rect x="9" y="7" width="2.5" height="7" rx="1.25" fill="white"/>
            <rect x="24.5" y="7" width="2.5" height="7" rx="1.25" fill="white"/>
            <text x="18" y="27" text-anchor="middle" font-size="10" font-weight="800" fill="#0078D4" font-family="Arial,sans-serif">31</text>
          </svg>
        </div>
        <div class="service-body">
          <div class="service-name">Microsoft Outlook</div>
          <ol class="steps">
            <li>ICSファイルをダウンロード</li>
            <li><code>outlook.live.com</code> を開く（またはOutlookアプリ）</li>
            <li>カレンダー → 「カレンダーの追加」→「ファイルから」</li>
          </ol>
        </div>
      </div>

    </div>
  `;

  // ── イベントハンドラ ──

  function getCurrentDates() {
    return {
      start: document.getElementById('termStart').value,
      end:   document.getElementById('termEnd').value,
    };
  }

  async function onDateChange() {
    await saveTermDates(year, term, getCurrentDates());
    const el = document.querySelector('.date-source');
    if (el) el.textContent = '（手動設定）';
  }

  document.getElementById('termStart').addEventListener('change', onDateChange);
  document.getElementById('termEnd').addEventListener('change', onDateChange);

  const resetBtn = document.getElementById('resetDates');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await clearTermDates(year, term);
      const def = calendar.terms[term];
      if (def) {
        document.getElementById('termStart').value = def.start;
        document.getElementById('termEnd').value   = def.end;
        const el = document.querySelector('.date-source');
        if (el) el.textContent = `（${calendarFilename}）`;
      }
    });
  }

  if (!noCourses) {
    let allChecked = true;
    document.getElementById('selectAll').addEventListener('click', () => {
      allChecked = !allChecked;
      document.querySelectorAll('#courseList input[type="checkbox"]')
        .forEach(cb => { cb.checked = allChecked; });
    });
  }

  document.getElementById('downloadBtn').addEventListener('click', () => {
    const d = getCurrentDates();

    if (!d.start || !d.end) {
      alert('ターム期間の開始日・終了日を入力してください。');
      return;
    }
    if (d.start > d.end) {
      alert('開始日が終了日より後になっています。');
      return;
    }

    const checkedIndices = Array.from(
      document.querySelectorAll('#courseList input[type="checkbox"]:checked')
    ).map(cb => parseInt(cb.dataset.index, 10));

    if (checkedIndices.length === 0) {
      alert('エクスポートする科目を選択してください。');
      return;
    }

    const checkedFormats = hasFormatData
      ? new Set(Array.from(document.querySelectorAll('#formatFilters input[type="checkbox"]:checked')).map(cb => cb.dataset.format))
      : null;

    const selected = checkedIndices.map(i => courses[i]).filter(c => {
      if (!checkedFormats) return true;
      return checkedFormats.has(classrooms[c.courseCode]?.format || '');
    });

    if (selected.length === 0) {
      alert('エクスポートする科目がありません。授業形態の絞り込みを確認してください。');
      return;
    }

    const ics = generateICS(selected, d.start, d.end, termLabel, calendar, classrooms);
    downloadICS(ics, `${termLabel.replace(' ', '_')}_時間割.ics`);
  });

  document.getElementById('howtoToggle').addEventListener('click', () => {
    const btn     = document.getElementById('howtoToggle');
    const section = document.getElementById('howtoSection');
    btn.classList.toggle('open');
    section.classList.toggle('open');
  });
}

function renderDateInputs(dates, showReset) {
  return `
    <div class="term-dates">
      <input type="date" id="termStart" value="${dates.start}">
      <span class="separator">〜</span>
      <input type="date" id="termEnd" value="${dates.end}">
      ${showReset
        ? `<button id="resetDates" title="calendars/YYYY.json の値に戻す" style="
             margin-left:4px;background:none;border:none;cursor:pointer;
             color:#888;font-size:11px;padding:0;white-space:nowrap;
           ">↩ リセット</button>`
        : ''
      }
    </div>
  `;
}

function renderCourseItem(course, index, classrooms = {}) {
  const dayName   = DAY_NAMES[course.day] || '?';
  const pLabel    = course.periodStart === course.periodEnd
    ? `${course.periodStart}限`
    : `${course.periodStart}〜${course.periodEnd}限`;
  const startTime = PERIOD_TIMES[course.periodStart]?.start || '';
  const endTime   = PERIOD_TIMES[course.periodEnd]?.end   || '';
  const timeRange = startTime && endTime ? `${startTime}〜${endTime}` : '';
  const kdb    = classrooms[course.courseCode];
  const room   = kdb?.room   || '';
  const format = kdb?.format || '';

  return `
    <div class="course-item">
      <input type="checkbox" checked data-index="${index}">
      <div class="course-info">
        <div class="course-name">${escapeHtml(course.name)}</div>
        <div class="course-meta">
          ${dayName}曜 ${pLabel}
          ${timeRange ? `<span style="color:#aaa">（${timeRange}）</span>` : ''}
          ${course.instructor ? `／ ${escapeHtml(course.instructor)}` : ''}
        </div>
        ${room   ? `<div class="course-room">🏫 ${escapeHtml(room)}</div>`   : ''}
        ${format ? `<div class="course-room">📡 ${escapeHtml(format)}</div>` : ''}
      </div>
      <span class="time-badge">${dayName} ${pLabel}</span>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── エントリーポイント ───────────────────────────────────────────────────

async function main() {
  let tab, kdbData, kdbMeta;
  try {
    [[tab], { kdbData, kdbMeta }] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      new Promise(resolve => chrome.storage.local.get(['kdbData', 'kdbMeta'], resolve)),
    ]);
  } catch {
    renderError('初期化に失敗しました。拡張機能を再読み込みしてください。');
    return;
  }

  // KdB ステータスバー
  const kdbBar = document.getElementById('kdbBar');
  if (kdbMeta) {
    kdbBar.className = 'kdb-bar';
    kdbBar.innerHTML = `🏫 教室データ: ${kdbMeta.count.toLocaleString()} 件
      <a id="kdbSettingsLink">設定 →</a>`;
  } else {
    kdbBar.className = 'kdb-bar missing';
    kdbBar.innerHTML = `教室データ未取り込み
      <a id="kdbSettingsLink">取り込む →</a>`;
  }
  document.getElementById('kdbSettingsLink')
    .addEventListener('click', () => chrome.runtime.openOptionsPage());

  if (!tab?.url?.includes('twins.tsukuba.ac.jp')) {
    renderNotOnTwins();
    return;
  }

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractCoursesFromPage,
    });
  } catch {
    renderError('ページの読み込みに失敗しました。<br>ページを再読み込みしてお試しください。');
    return;
  }

  if (!result?.result) {
    renderError('データを取得できませんでした。');
    return;
  }

  const { year } = result.result;

  // 年度が確定してからカレンダーファイルを読み込む
  const calendar = await loadCalendar(year);

  await renderCourses(result.result, calendar, year, kdbData ?? {});
}

document.addEventListener('DOMContentLoaded', main);
