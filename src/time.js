// src/time.js —— 中文时间表达式解析（本项目的心脏）
//
// 两阶段：
//   1) 词法：从文本里扫出所有「日期 / 时段 / 时刻 / 区间 / 相对时长 / 模糊词」token
//   2) 语法：把相邻的 日期 + 时段 + 时刻 合成一个完整时间点，并识别「前 / 之前 / 截止」为截止语义
//
// 对外 API：
//   findTimes(text, {now}) -> ResolvedSpan[]  (按出现顺序，带 index/end 用于原文高亮)
//   parseWhen(text, {now}) -> ResolvedSpan | null
//   describeWhen(due, {now, precision, isDeadline}) -> 人话标签

import { cnToInt, addDays, addMonths, startOfDay, daysBetween, pad2 } from './util.js';

export const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };

/** 时段词 -> 该时段的代表时刻（没写具体几点时用） */
const DAYPART_TIME = {
  凌晨: [1, 0], 清晨: [6, 0], 早晨: [7, 30], 早上: [8, 0], 上午: [9, 0],
  中午: [12, 0], 午后: [14, 0], 下午: [15, 0], 傍晚: [18, 0], 晚上: [19, 0],
  夜里: [21, 0], 夜间: [21, 0], 半夜: [23, 0],
};
const EVENING = new Set(['午后', '下午', '傍晚', '晚上', '夜里', '夜间', '半夜']);
const MORNING = new Set(['凌晨', '清晨', '早晨', '早上', '上午']);

/** 相对日 */
const REL_DAY = {
  今天: 0, 今日: 0, 今儿: 0, 当天: 0, 本日: 0,
  明天: 1, 明日: 1, 明儿: 1, 次日: 1, 翌日: 1, 第二天: 1,
  后天: 2, 大后天: 3,
  昨天: -1, 昨日: -1, 前天: -2, 大前天: -3,
  今早: 0, 今晚: 0, 明早: 1, 明晚: 1,
};
const REL_DAY_DP = { 今早: '早上', 今晚: '晚上', 明早: '早上', 明晚: '晚上' };

const PERIOD = {
  下个月底: 'nextMonthEnd', 下月底: 'nextMonthEnd', 下月末: 'nextMonthEnd',
  下月月初: 'nextMonthStart',
  本月: 'monthStart', 这个月: 'monthStart', 这月: 'monthStart', 当月: 'monthStart',
  下个月: 'nextMonthStart', 下月: 'nextMonthStart', 下月月初: 'nextMonthStart',
  上个月: 'prevMonthStart', 上月: 'prevMonthStart',
  月底: 'monthEnd', 月末: 'monthEnd', 本月末: 'monthEnd', 这个月底: 'monthEnd',
  下月底: 'nextMonthEnd', 下个月底: 'nextMonthEnd',
  月初: 'monthStart', 本月初: 'monthStart',
  今年: 'yearStart', 本年: 'yearStart', 明年: 'nextYearStart', 去年: 'prevYearStart',
  年底: 'yearEnd', 年末: 'yearEnd', 明年年底: 'nextYearEnd',
  今年年底: 'yearEnd', 今年底: 'yearEnd', 今年年末: 'yearEnd', 明年底: 'nextYearEnd',
  年初: 'yearStart', 本年初: 'yearStart',
  本周: 'weekStart', 这周: 'weekStart', 这个星期: 'weekStart', 这星期: 'weekStart',
  下周: 'nextWeekStart', 下个星期: 'nextWeekStart', 下星期: 'nextWeekStart',
  上周: 'prevWeekStart', 上个星期: 'prevWeekStart',
  上旬: 'monthEarly', 中旬: 'monthMid', 下旬: 'monthLate',
  上半年: 'h1', 下半年: 'h2',
  本季度: 'quarterStart', 这个季度: 'quarterStart', 下季度: 'nextQuarterStart', 下个季度: 'nextQuarterStart',
};

/** 节日：固定日期的用表查，农历节日用人工维护的年度表（只覆盖 2025-2027，超出范围就不猜） */
const FESTIVAL = {
  元旦: ['fixed', 1, 1],
  情人节: ['fixed', 2, 14],
  劳动节: ['fixed', 5, 1],
  五一: ['fixed', 5, 1],
  儿童节: ['fixed', 6, 1],
  六一: ['fixed', 6, 1],
  教师节: ['fixed', 9, 10],
  国庆节: ['fixed', 10, 1],
  国庆: ['fixed', 10, 1],
  万圣节: ['fixed', 10, 31],
  双十一: ['fixed', 11, 11],
  光棍节: ['fixed', 11, 11],
  双十二: ['fixed', 12, 12],
  平安夜: ['fixed', 12, 24],
  圣诞节: ['fixed', 12, 25],
  圣诞: ['fixed', 12, 25],
  春节: ['lunar', { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6] }],
  除夕: ['lunar', { 2025: [1, 28], 2026: [2, 16], 2027: [2, 5] }],
  元宵节: ['lunar', { 2025: [2, 12], 2026: [3, 3], 2027: [2, 20] }],
  元宵: ['lunar', { 2025: [2, 12], 2026: [3, 3], 2027: [2, 20] }],
  端午节: ['lunar', { 2025: [5, 31], 2026: [6, 19], 2027: [6, 9] }],
  端午: ['lunar', { 2025: [5, 31], 2026: [6, 19], 2027: [6, 9] }],
  中秋节: ['lunar', { 2025: [10, 6], 2026: [9, 25], 2027: [9, 15] }],
  中秋: ['lunar', { 2025: [10, 6], 2026: [9, 25], 2027: [9, 15] }],
};

const FESTIVAL_RE = /(元宵节|端午节|中秋节|国庆节|劳动节|儿童节|教师节|情人节|万圣节|平安夜|圣诞节|双十一|双十二|光棍节|元旦|春节|除夕|元宵|端午|中秋|国庆|五一|六一|圣诞)/g;

/** 节日 -> 具体日期；表里没有的年份返回 null（宁可不猜） */
function festivalDate(key, year) {
  const entry = FESTIVAL[key];
  if (!entry) return null;
  if (entry[0] === 'fixed') return [entry[1], entry[2]];
  return entry[1][year] || null;
}

/* ────────────────────────────── 词法 ────────────────────────────── */

const NUM = '(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})';

const PATTERNS = [
  // 2025年5月3日 / 2025-05-03 / 2025.5.3 / 二〇二五年五月三日
  {
    re: /(\d{4}|[一二三四五六七八九〇零]{4})\s*[年\-\/.]\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[月\-\/.]\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]?/g,
    build: (m) => makeAbs(null, m[1], m[2], m[3]),
  },
  // 5月3日 / 5月3号
  {
    re: /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[日号]/g,
    build: (m) => makeAbs(null, null, m[1], m[2]),
  },
  // 5月 / 5月底 / 5月中旬
  {
    re: /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月(份|底|末|初|中旬|上旬|下旬|中)?/g,
    build: (m) => {
      const mo = cnToInt(m[1]);
      if (mo == null || mo < 1 || mo > 12) return null;
      const sub = m[2] || '';
      if (sub === '底' || sub === '末') return makeAbs(null, null, m[1], null, { monthEnd: true });
      if (sub === '初') return makeAbs(null, null, m[1], 1);
      if (sub === '上旬') return makeAbs(null, null, m[1], 5);
      if (sub === '中旬') return makeAbs(null, null, m[1], 15);
      if (sub === '下旬') return makeAbs(null, null, m[1], 25);
      return makeAbs(null, null, m[1], null);
    },
  },
  // 下个月15号 / 本月20日
  {
    re: /(下个?月|这个?月|本月)\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]/g,
    build: (m) => {
      const off = /^下/.test(m[1]) ? 1 : 0;
      const d = cnToInt(m[2]);
      if (d == null || d < 1 || d > 31) return null;
      return { type: 'absdate', y: null, m: null, d, monthOffset: off };
    },
  },
  // 5/3、5-3（排除 9:30、3-5人、2025-05）
  {
    re: /(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?![\d:：])/g,
    build: (m, text) => {
      const idx = m.index;
      const prev = idx > 0 ? text[idx - 1] : '';
      const after = text.slice(idx + m[0].length).replace(/^\s+/, '');
      const next = after[0] || '';
      if (/[\d:：\u4e00-\u9fa5]/.test(prev)) return null;   // 前面是数字/汉字（如 2025-05 / 周5-3）
      if (/[个元块%％点时分秒岁人位次条项天周月年张份件斤克米折成倍页]/.test(next)) return null; // 3-5 人 / 1-2 天
      const mo = +m[1], da = +m[2];
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      return makeAbs(null, null, mo, da);
    },
  },
  // 3日 / 15号 / 十五号（不带月份，当前月或下个月）
  {
    re: /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*([号日])(?![\d期])/g,
    build: (m, text) => {
      const idx = m.index;
      const prev = idx > 0 ? text[idx - 1] : '';
      if (/[\d年]/.test(prev)) return null;
      if (/月/.test(prev)) return null;                  // 「5月3日」交给上一条规则
      const d = cnToInt(m[1]);
      if (d == null || d < 1 || d > 31) return null;
      return { type: 'dayonly', d };
    },
  },
  // 周 / 星期 / 礼拜 + 一二三四五六日末
  {
    re: /(本|这|这个|当|下|下个|下下|上|上个|每)?\s*(周|星期|礼拜)\s*([一二三四五六日天末]|[1-7])/g,
    build: (m) => {
      const wd = WEEKDAY_CN[m[3]];
      if (!wd) return null;
      const p = m[1] || '';
      let weekOffset = 0;
      if (p === '下' || p === '下个') weekOffset = 1;
      else if (p === '下下') weekOffset = 2;
      else if (p === '上' || p === '上个') weekOffset = -1;
      const explicit = /^(本|这|这个|当)$/.test(p);
      return { type: 'weekday', weekOffset, wd, explicit, anyway: p === '每' };
    },
  },
  // 相对日
  {
    re: /(大后天|大前天|后天|前天|明天|明日|明早|明晚|明儿|今天|今日|今早|今晚|今儿|当天|本日|次日|翌日|第二天|昨天|昨日)/g,
    build: (m) => ({ type: 'relday', rel: REL_DAY[m[1]], dp: REL_DAY_DP[m[1]] || null }),
  },
  // 周期词
  {
    re: /(下个月底|下月底|下月末|下月月初|这个月底|这个月末|本月末|下个月|上个月|本季度|下个季度|这个季度|下个星期|上个星期|这个星期|今年年底|今年底|明年底|今年年末|本月|这个月|这月|当月|下月|上月|月底|月末|月初|本月初|这星期|下星期|下周|本周|这周|上周|明年年底|今年|本年|明年|去年|年底|年末|年初|本年初|上旬|中旬|下旬|上半年|下半年|下季度)/g,
    build: (m) => {
      const key = PERIOD[m[1]];
      if (!key) return null;
      return { type: 'period', key, raw: m[1] };
    },
  },
  // 4位年份
  {
    re: /(\d{4})\s*年(度|底|末|初)?/g,
    build: (m) => ({ type: 'year', y: +m[1], sub: m[2] || '' }),
  },
  // 区间：9:00-11:00
  {
    re: /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g,
    build: (m) => ({ type: 'range', a: { h: +m[1], mi: +m[2] }, b: { h: +m[3], mi: +m[4] } }),
  },
  // 区间：8-10点 / 9~11点（第一个数后面没有「点」）
  {
    re: /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[-–—~～至到]\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*点/g,
    build: (m) => {
      const a = cnToInt(m[1]), b = cnToInt(m[2]);
      if (!a || !b || a > 24 || b > 24) return null;
      return { type: 'range', a: { h: a, mi: 0 }, b: { h: b, mi: 0 } };
    },
  },
  // 区间：9点到11点 / 8点半到10点半（两端的「半」都要带上）
  {
    re: /(\d{1,2}|[一二三四五六七八九十]{1,3})\s*点\s*(半)?\s*[-–—~～至到]\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*点\s*(半)?/g,
    build: (m) => {
      const a = cnToInt(m[1]), b = cnToInt(m[3]);
      if (a == null || b == null || a > 24 || b > 24) return null;
      return { type: 'range', a: { h: a, mi: m[2] ? 30 : 0 }, b: { h: b, mi: m[4] ? 30 : 0 } };
    },
  },
  // 节日：国庆 / 五一 / 春节 / 中秋 …
  {
    re: FESTIVAL_RE,
    build: (m) => (FESTIVAL[m[1]] ? { type: 'festival', key: m[1] } : null),
  },
  // 时刻：9:30
  {
    re: /(\d{1,2})\s*[:：]\s*(\d{2})(?![\d])/g,
    build: (m, text) => {
      const idx = m.index;
      const prev = idx > 0 ? text[idx - 1] : '';
      if (/[a-zA-Z\/]/.test(prev)) return null; // http:// 、12/3 之类
      const h = +m[1], mi = +m[2];
      if (h > 24 || mi > 59) return null;
      return { type: 'clock', h: h === 24 ? 0 : h, mi };
    },
  },
  // 时刻：3点 / 3点半 / 3点15分 / 三点一刻
  {
    re: new RegExp(`(${NUM})\\s*点\\s*(半|一刻|三刻|整|(\\d{1,2})\\s*分?)?`, 'g'),
    build: (m) => {
      const h = cnToInt(m[1]);
      if (h == null || h > 24) return null;
      let mi = 0;
      if (m[2] === '半') mi = 30;
      else if (m[2] === '一刻') mi = 15;
      else if (m[2] === '三刻') mi = 45;
      else if (m[3]) mi = cnToInt(m[3]) || 0;
      if (mi > 59) return null;
      return { type: 'clock', h: h === 24 ? 0 : h, mi };
    },
  },
  // 相对时长：三天内 / 一周后 / 半小时后
  {
    re: /(\d+|[一二两三四五六七八九十]+|半)\s*(个?)(天|日|周|个?星期|个?月|小时|钟头|分钟)\s*(内|以内|之内|后|之后|以前|之前)/g,
    build: (m) => {
      const n = m[1] === '半' ? 0.5 : cnToInt(m[1]);
      if (n == null || n === 0) return null;
      const unit = m[3];
      const mode = /内/.test(m[4]) ? 'within' : (/前/.test(m[4]) ? 'before' : 'after');
      return { type: 'durrel', n, unit, mode };
    },
  },
  // 生活作息里的「时刻」：下班前 = 18:00 且是截止语义
  {
    re: /(下班之前|下班前|下班|上班之前|上班前|午休前|午休|放学后|放学|晚饭前|午饭前|早饭前)/g,
    build: (m) => {
      const MAP = {
        下班之前: [18, 0], 下班前: [18, 0], 下班: [18, 0],
        上班之前: [9, 0], 上班前: [9, 0],
        午休前: [12, 0], 午休: [12, 0],
        放学后: [17, 0], 放学: [17, 0],
        晚饭前: [18, 0], 午饭前: [12, 0], 早饭前: [8, 0],
      };
      const [h, mi] = MAP[m[1]] || [18, 0];
      return { type: 'clock', h, mi, deadlineHint: /前|之前/.test(m[1]) };
    },
  },
  // 时段词
  {
    re: /(凌晨|清晨|早晨|早上|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|半夜)/g,
    build: (m) => ({ type: 'daypart', dp: m[1] }),
  },
  // 模糊词
  {
    re: /(尽快|马上|立刻|立即|随时|方便的时候|有空|待定|之后再说|后续|稍后|稍候|不久|待会儿|待会|一会儿|回头再说|看情况)/g,
    build: (m) => ({ type: 'vague', word: m[1] }),
  },
];

function makeAbs(y, yy, mm, dd, extra = {}) {
  const Y = y != null ? (typeof y === 'number' ? y : cnToInt(y)) : yy != null ? cnToInt(yy) : null;
  const M = typeof mm === 'number' ? mm : cnToInt(mm);
  const D = dd == null ? null : (typeof dd === 'number' ? dd : cnToInt(dd));
  if (M == null || M < 1 || M > 12) return null;
  if (D != null && (D < 1 || D > 31)) return null;
  return { type: 'absdate', y: Y && Y > 1900 ? Y : null, m: M, d: D, ...extra };
}

/** 扫出所有 token，再按「起点早、长度长」贪心去重叠 */
export function tokenize(text) {
  const raw = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = p.re.exec(text)) !== null && guard++ < 5000) {
      if (!m[0].length) { p.re.lastIndex++; continue; }
      let tok = null;
      try { tok = p.build(m, text); } catch { tok = null; }
      if (!tok) continue;
      raw.push({ ...tok, index: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  raw.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
  const picked = [];
  let lastEnd = -1;
  for (const t of raw) {
    if (t.index >= lastEnd) { picked.push(t); lastEnd = t.end; }
  }
  return picked;
}

/* ────────────────────────────── 语法：合并相邻 token ────────────────────────────── */

const DATE_TYPES = new Set(['absdate', 'weekday', 'relday', 'period', 'dayonly', 'year', 'festival']);
const CONNECTOR = /^[\s的于在上·]{0,3}$/;

function canFill(span, tok) {
  if (tok.type === 'daypart') return !span.dp && !span.clock && !span.range;
  if (tok.type === 'clock') return !span.clock && !span.range && !span.durrel;
  if (tok.type === 'range') return !span.clock && !span.range;
  if (DATE_TYPES.has(tok.type)) return !span.date;
  return false;
}

function absorb(span, tok) {
  if (tok.type === 'daypart') span.dp = tok.dp;
  else if (tok.type === 'clock') span.clock = { h: tok.h, mi: tok.mi };
  else if (tok.type === 'range') span.range = { a: tok.a, b: tok.b };
  else { span.date = tok; if (tok.dp && !span.dp) span.dp = tok.dp; }
  if (tok.deadlineHint) span.isDeadline = true;
  span.end = tok.end;
  span.tokens.push(tok);
}

function buildSpans(text, tokens) {
  const spans = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const span = {
      index: t.index, end: t.end, tokens: [t],
      date: DATE_TYPES.has(t.type) ? t : null,
      dp: t.type === 'daypart' ? t.dp : (t.dp || null),
      clock: t.type === 'clock' ? { h: t.h, mi: t.mi } : null,
      range: t.type === 'range' ? { a: t.a, b: t.b } : null,
      durrel: t.type === 'durrel' ? t : null,
      vague: t.type === 'vague' ? t.word : null,
      isDeadline: !!t.deadlineHint,
    };
    let j = i + 1;
    while (j < tokens.length && !span.durrel && !span.vague) {
      const nxt = tokens[j];
      const gap = text.slice(span.end, nxt.index);
      if (!CONNECTOR.test(gap)) break;
      // 特例：2025年 + 5月3日 -> 合成完整日期
      if (span.date && span.date.type === 'year' && nxt.type === 'absdate' && nxt.y == null) {
        span.date = { ...nxt, y: span.date.y };
        span.end = nxt.end;
        span.tokens.push(nxt);
        j++;
        continue;
      }
      if (!canFill(span, nxt)) break;
      absorb(span, nxt);
      j++;
    }
    // 截止语义：后面跟 前 / 之前 / 以前 / 截止
    const after = text.slice(span.end, span.end + 6);
    const md = after.match(/^\s*(之前|以前|前|截止|为止)/);
    if (md && !/前后/.test(after)) {
      span.isDeadline = true;
      span.end += md[0].length;
    }
    // 前面有「截止 / 截至 / DDL」
    const before = text.slice(Math.max(0, span.index - 12), span.index);
    if (/(截止|截至|deadline|ddl|最后期限|之前|以内|为止)/i.test(before)) span.isDeadline = true;

    span.text = text.slice(span.index, span.end);
    spans.push(span);
    i = j;
  }
  return spans;
}

/* ────────────────────────────── 语义：解析成具体日期 ────────────────────────────── */

function resolveDateTok(tok, ref) {
  const now = startOfDay(ref);
  if (!tok) return { base: now, precision: 'none' };

  if (tok.type === 'absdate') {
    let y = tok.y != null ? tok.y : ref.getFullYear();
    let mo = tok.m;
    if (mo == null && tok.monthOffset != null) mo = ref.getMonth() + 1 + tok.monthOffset;
    if (tok.monthEnd) return { base: new Date(y, mo, 0), precision: 'day' }; // 下个月第 0 天 = 本月最后一天
    if (tok.d == null) {
      let d = new Date(y, mo - 1, 1);
      if (tok.y == null && tok.m == null) {
        // 无月份信息，仅占位
      } else if (tok.y == null && d < addDays(now, -20)) {
        d = new Date(y + 1, mo - 1, 1);
      }
      return { base: d, precision: 'month' };
    }
    let d = new Date(y, mo - 1, tok.d);
    // 没写年份时：已经过去太久的日期理解为明年
    if (tok.y == null && tok.m != null && d < addDays(now, -45)) d = new Date(y + 1, mo - 1, tok.d);
    return { base: d, precision: 'day' };
  }

  if (tok.type === 'dayonly') {
    let d = new Date(ref.getFullYear(), ref.getMonth(), tok.d);
    if (tok.d < ref.getDate()) d = addMonths(d, 1);
    return { base: d, precision: 'day' };
  }

  if (tok.type === 'relday') {
    return { base: addDays(now, tok.rel), precision: 'day' };
  }

  if (tok.type === 'weekday') {
    const refWd = ref.getDay() === 0 ? 7 : ref.getDay();
    const weekStart = addDays(now, -(refWd - 1));
    let offset = tok.weekOffset;
    if (offset === 0 && !tok.explicit && tok.wd < refWd) offset = 1; // 「周五」在周六说 = 下周五
    return { base: addDays(weekStart, offset * 7 + (tok.wd - 1)), precision: 'day' };
  }

  if (tok.type === 'period') {
    const y = ref.getFullYear(), m = ref.getMonth();
    switch (tok.key) {
      case 'monthStart': return { base: new Date(y, m, 1), precision: 'month' };
      case 'nextMonthStart': return { base: new Date(y, m + 1, 1), precision: 'month' };
      case 'prevMonthStart': return { base: new Date(y, m - 1, 1), precision: 'month' };
      case 'monthEnd': return { base: new Date(y, m + 1, 0), precision: 'day' };
      case 'nextMonthEnd': return { base: new Date(y, m + 2, 0), precision: 'day' };
      case 'monthEarly': return { base: new Date(y, m, 5), precision: 'day' };
      case 'monthMid': return { base: new Date(y, m, 15), precision: 'day' };
      case 'monthLate': return { base: new Date(y, m, 25), precision: 'day' };
      case 'yearStart': return { base: new Date(y, 0, 1), precision: 'year' };
      case 'nextYearStart': return { base: new Date(y + 1, 0, 1), precision: 'year' };
      case 'prevYearStart': return { base: new Date(y - 1, 0, 1), precision: 'year' };
      case 'yearEnd': return { base: new Date(y, 11, 31), precision: 'day' };
      case 'nextYearEnd': return { base: new Date(y + 1, 11, 31), precision: 'day' };
      case 'weekStart': {
        const refWd = ref.getDay() === 0 ? 7 : ref.getDay();
        return { base: addDays(now, -(refWd - 1)), precision: 'day' };
      }
      case 'nextWeekStart': {
        const refWd = ref.getDay() === 0 ? 7 : ref.getDay();
        return { base: addDays(now, 7 - (refWd - 1)), precision: 'day' };
      }
      case 'prevWeekStart': {
        const refWd = ref.getDay() === 0 ? 7 : ref.getDay();
        return { base: addDays(now, -7 - (refWd - 1)), precision: 'day' };
      }
      case 'h1': return { base: new Date(y, 0, 1), precision: 'month' };
      case 'h2': return { base: new Date(y, 6, 1), precision: 'month' };
      case 'quarterStart': { const q = Math.floor(m / 3) * 3; return { base: new Date(y, q, 1), precision: 'month' }; }
      case 'nextQuarterStart': { const q = Math.floor(m / 3) * 3 + 3; return { base: new Date(y, q, 1), precision: 'month' }; }
      default: return { base: now, precision: 'none' };
    }
  }

  if (tok.type === 'festival') {
    const y = ref.getFullYear();
    let md = festivalDate(tok.key, y);
    let year = y;
    if (md) {
      let d = new Date(year, md[0] - 1, md[1]);
      if (d < addDays(now, -1)) {                    // 今年的已经过了 -> 明年
        const nxt = festivalDate(tok.key, year + 1);
        if (nxt) { year += 1; md = nxt; d = new Date(year, md[0] - 1, md[1]); }
      }
      return { base: d, precision: 'day', festival: true };
    }
    const nxt = festivalDate(tok.key, y + 1);
    if (nxt) return { base: new Date(y + 1, nxt[0] - 1, nxt[1]), precision: 'day', festival: true };
    return { base: null, precision: 'none' };        // 表里没这年，不猜
  }

  if (tok.type === 'year') {
    if (tok.sub === '底' || tok.sub === '末') return { base: new Date(tok.y, 11, 31), precision: 'day' };
    return { base: new Date(tok.y, 0, 1), precision: 'year' };
  }

  return { base: now, precision: 'none' };
}

function combine(base, h, mi) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, 0, 0);
}

/** 时段词 + 小时 -> 24 小时制 */
function adjustHour(dp, h) {
  if (!dp) return h;
  if (EVENING.has(dp)) return h < 12 ? h + 12 : (h === 12 ? 0 : h);
  if (dp === '中午') return h < 11 ? h + 12 : h;
  if (MORNING.has(dp)) return h === 12 ? 0 : h;
  return h;
}

/** 把 span 解析成 {start, end2, precision, hasTime, isDeadline} */
export function resolveSpan(span, ref) {
  // 相对时长：三天内 / 一周后
  if (span.durrel) {
    const { n, unit, mode } = span.durrel;
    const MS = { day: 86400000, week: 604800000, month: 2592000000, hour: 3600000, minute: 60000 };
    let ms = 0;
    if (/天|日/.test(unit)) ms = n * MS.day;
    else if (/周|星期/.test(unit)) ms = n * MS.week;
    else if (/月/.test(unit)) ms = n * MS.month;
    else if (/小时|钟头/.test(unit)) ms = n * MS.hour;
    else if (/分钟/.test(unit)) ms = n * MS.minute;
    const d = new Date(ref.getTime() + ms);
    const hasTime = /小时|钟头|分钟/.test(unit);
    return {
      start: d, end2: null,
      precision: hasTime ? 'minute' : 'day',
      hasTime,
      isDeadline: mode !== 'after' || span.isDeadline,
      vague: false,
    };
  }

  if (span.vague) {
    // 模糊词：给个温和的提醒时间（今天/明天傍晚），不硬塞日期
    return { start: null, end2: null, precision: 'none', hasTime: false, isDeadline: false, vague: true };
  }

  const { base, precision: dp0, festival } = resolveDateTok(span.date, ref);
  // 节日表里没有这一年的日期（比如 2031 年的春节）—— 不猜
  if (span.date && !base) {
    return { start: null, end2: null, precision: 'none', hasTime: false, isDeadline: false, vague: false };
  }
  let precision = dp0;

  if (span.range) {
    const s = combine(base, adjustHour(span.dp, span.range.a.h), span.range.a.mi);
    let e = combine(base, adjustHour(span.dp, span.range.b.h), span.range.b.mi);
    if (e <= s) e = addDays(e, 1);
    // 没写日期且整段已经过去 -> 顺延到明天
    if (!span.date && e.getTime() < ref.getTime() - 15 * 60000) {
      return { start: addDays(s, 1), end2: addDays(e, 1), precision: 'minute', hasTime: true, isDeadline: span.isDeadline, vague: false };
    }
    return { start: s, end2: e, precision: 'minute', hasTime: true, isDeadline: span.isDeadline, vague: false };
  }

  if (span.clock) {
    const h = adjustHour(span.dp, span.clock.h);
    let s = combine(base, h, span.clock.mi);
    // 没写日期、时刻已经明显过去 -> 明天
    if (!span.date && s.getTime() < ref.getTime() - 15 * 60000) s = addDays(s, 1);
    return { start: s, end2: null, precision: 'minute', hasTime: true, isDeadline: span.isDeadline, vague: false };
  }

  if (span.dp && !span.date) {
    const [h, mi] = DAYPART_TIME[span.dp] || [9, 0];
    let s = combine(base, h, mi);
    if (s.getTime() < ref.getTime() - 15 * 60000) s = addDays(s, 1);
    return { start: s, end2: null, precision: 'daypart', hasTime: true, isDeadline: span.isDeadline, vague: false };
  }

  if (span.dp && span.date) {
    const [h, mi] = DAYPART_TIME[span.dp] || [9, 0];
    return { start: combine(base, h, mi), end2: null, precision: 'daypart', hasTime: true, isDeadline: span.isDeadline, vague: false };
  }

  if (!span.date) return { start: null, end2: null, precision: 'none', hasTime: false, isDeadline: false, vague: false };

  // 只有日期。节日 + 「前」= 节前最后一天（国庆前 -> 9/30）
  if (precision === 'month' || precision === 'year') {
    return { start: base, end2: null, precision, hasTime: false, isDeadline: span.isDeadline, vague: false };
  }
  if (festival && span.isDeadline) {
    return { start: startOfDay(addDays(base, -1)), end2: null, precision: 'day', hasTime: false, isDeadline: true, vague: false };
  }
  return { start: startOfDay(base), end2: null, precision: 'day', hasTime: false, isDeadline: span.isDeadline, vague: false };
}

export function findTimes(text, opts = {}) {
  const ref = opts.now instanceof Date ? opts.now : new Date();
  const tokens = tokenize(text);
  const spans = buildSpans(text, tokens);
  const out = [];
  for (const sp of spans) {
    const r = resolveSpan(sp, ref);
    if (!r.start && !r.vague) continue;
    out.push({
      index: sp.index, end: sp.end, text: sp.text,
      ...r,
      kind: r.isDeadline ? 'deadline' : (r.start && r.start.getHours() === 0 && r.start.getMinutes() === 0 && !r.hasTime ? 'day' : 'point'),
    });
  }
  return out;
}

export function parseWhen(text, opts = {}) {
  const all = findTimes(text, opts);
  return all.find((t) => t.start) || null;
}

/* ────────────────────────────── 人话标签 ────────────────────────────── */

export function describeWhen(due, opts = {}) {
  if (!due) return '';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const d = due instanceof Date ? due : new Date(due);
  if (Number.isNaN(d.getTime())) return '';
  const precision = opts.precision || 'minute';
  const diff = daysBetween(now, d);

  const wd = WEEKDAY_NAMES[d.getDay()];
  const ymd = `${d.getMonth() + 1}月${d.getDate()}日`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  let day;
  if (diff === 0) day = '今天';
  else if (diff === 1) day = '明天';
  else if (diff === 2) day = '后天';
  else if (diff === -1) day = '昨天';
  else if (diff > 2 && diff < 7) day = `周${wd}`;
  else if (d.getFullYear() === now.getFullYear()) day = `${ymd} 周${wd}`;
  else day = `${d.getFullYear()}年${ymd}`;

  if (diff < 0 && opts.overdue !== false) day = `已逾期${-diff}天 · ${day}`;

  if (precision === 'month') return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  if (precision === 'year') return `${d.getFullYear()}年`;
  if (precision === 'day') return `${day} 全天`;
  return `${day} ${hm}`;
}
