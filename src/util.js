// src/util.js —— 无依赖小工具
// 注意：本文件里的 normalize 必须「逐字符 1:1 替换」，绝不增删字符，
// 这样抽取结果里的偏移量才能直接对应到用户原文，用于高亮回证。

export const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DDTHH:mm'（本地时间，喂给 <input type="datetime-local">） */
export function toLocalInput(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

/** 'YYYY-MM-DDTHH:mm' -> Date（按本地时区解释，不用 Date 的 UTC 陷阱） */
export function fromLocalInput(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d, n) {
  const x = new Date(d.getTime());
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  const dim = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, dim));
  return x;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function sameDay(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

/** 中文数字 -> 整数。支持 十/十一/二十/二十三/两/一九九八（年份按逐位拼） */
export function cnToInt(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
  if (s === '十') return 10;
  const tens = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (tens) return (tens[1] ? map[tens[1]] : 1) * 10 + (tens[2] ? map[tens[2]] : 0);
  if (/^[零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖]+$/.test(s)) {
    // 一九九八 / 二〇二五 这类按位读的年份
    if (s.length >= 3) return parseInt([...s].map((c) => map[c]).join(''), 10);
    return map[s];
  }
  return null;
}

/**
 * 归一化：只做 1:1 长度的字符替换，保证下标与原文一致。
 * 全角数字/字母/冒号/空格统一，去除零宽字符（替换成空格而不是删除）。
 */
export function normalize(text) {
  const out = new Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const code = c.charCodeAt(0);
    let r = c;
    if (code === 0x3000) r = ' ';                       // 全角空格
    else if (code >= 0xff10 && code <= 0xff19) r = String.fromCharCode(code - 0xfee0); // ０-９
    else if (code >= 0xff21 && code <= 0xff3a) r = String.fromCharCode(code - 0xfee0); // Ａ-Ｚ
    else if (code >= 0xff41 && code <= 0xff5a) r = String.fromCharCode(code - 0xfee0); // ａ-ｚ
    else if (code === 0xff1a) r = '：';
    else if (code === 0x200b || code === 0xfeff || code === 0x200c) r = ' ';
    out[i] = r;
  }
  return out.join('');
}

/** 文本相似度（字符二元组 Jaccard），用于判断两条待办是不是同一件事 */
export function similarity(a, b) {
  const grams = (s) => {
    const t = String(s || '').replace(/[\s，。、；：,.;:!?！？"'“”‘’()（）【】\[\]]/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (!set.size && t) set.add(t);
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

let seq = 0;
export function uid(prefix = 'td') {
  seq = (seq + 1) % 10000;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 收起多余空白，去掉首尾标点 */
export function tidy(s) {
  return String(s || '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^[\s,，。、;；:：\-–—·、]+/, '')
    .replace(/[\s,，、;；:：\-–—·]+$/, '')
    .trim();
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
