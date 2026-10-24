// src/model.js —— 纯数据层（不碰 DOM / localStorage，方便单测）
// 待办对象：
// { id, title, due, dueEnd, dueText, precision, deadline, place, people[], notes,
//   priority, category, done, createdAt, updatedAt, source }

import { fromLocalInput, toLocalInput, daysBetween, similarity, uid } from './util.js';
import { describeWhen, WEEKDAY_NAMES } from './time.js';

export const CATEGORIES = {
  work: '工作', study: '学习', life: '生活', health: '健康',
  money: '钱款', social: '人际', other: '其他',
};
export const PRIORITIES = { high: '重要', normal: '普通', low: '不急' };
export const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };

export const GROUPS = [
  { key: 'overdue', title: '已逾期' },
  { key: 'today', title: '今天' },
  { key: 'tomorrow', title: '明天' },
  { key: 'week', title: '本周内' },
  { key: 'later', title: '以后' },
  { key: 'someday', title: '没有时间' },
  { key: 'done', title: '已完成' },
];

/** 把抽取结果或用户手填内容整理成规范待办 */
export function makeTodo(input = {}) {
  const now = new Date();
  const priority = PRIORITIES[input.priority] ? input.priority : 'normal';
  const category = CATEGORIES[input.category] ? input.category : 'other';
  return {
    id: input.id || uid(),
    title: String(input.title || '').trim() || '（未命名）',
    due: input.due || null,
    dueEnd: input.dueEnd || null,
    dueText: input.dueText || '',
    precision: input.precision || (input.due ? 'minute' : 'none'),
    deadline: !!input.deadline,
    place: input.place || '',
    people: Array.isArray(input.people) ? input.people.slice(0, 8) : [],
    notes: input.notes || '',
    priority,
    category,
    done: !!input.done,
    createdAt: input.createdAt || now.toISOString(),
    updatedAt: input.updatedAt || now.toISOString(),
    source: input.source && input.source.text ? { text: input.source.text, marks: input.source.marks || [] } : null,
  };
}

export function dueDate(todo) {
  return todo && todo.due ? fromLocalInput(todo.due) : null;
}

export function isOverdue(todo, now = new Date()) {
  const d = dueDate(todo);
  if (!d || todo.done) return false;
  return d.getTime() < now.getTime();
}

export function dueLabel(todo, now = new Date()) {
  const d = dueDate(todo);
  if (!d) return '没有时间';
  return describeWhen(d, { now, precision: todo.precision || 'minute', overdue: !todo.done });
}

/** 分组：[{key,title,items,count}] */
export function groupTodos(todos, now = new Date(), opts = {}) {
  const buckets = new Map(GROUPS.map((g) => [g.key, []]));
  for (const t of todos) {
    if (t.done) { buckets.get('done').push(t); continue; }
    const d = dueDate(t);
    if (!d) { buckets.get('someday').push(t); continue; }
    const diff = daysBetween(now, d);
    if (diff < 0) buckets.get('overdue').push(t);
    else if (diff === 0) buckets.get('today').push(t);
    else if (diff === 1) buckets.get('tomorrow').push(t);
    else if (diff <= 6) buckets.get('week').push(t);
    else buckets.get('later').push(t);
  }
  const out = [];
  for (const g of GROUPS) {
    const items = buckets.get(g.key);
    if (!items.length) continue;
    if (g.key === 'done' && opts.hideDone) continue;
    items.sort((a, b) => {
      const da = dueDate(a), db = dueDate(b);
      if (da && db && da.getTime() !== db.getTime()) return da - db;
      if (da && !db) return -1;
      if (!da && db) return 1;
      const pa = PRIORITY_WEIGHT[a.priority] ?? 1, pb = PRIORITY_WEIGHT[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
    out.push({ ...g, items, count: items.length });
  }
  return out;
}

export function filterTodos(todos, opts = {}) {
  const q = String(opts.q || '').trim().toLowerCase();
  const cat = opts.cat || 'all';
  return todos.filter((t) => {
    if (opts.hideDone && t.done) return false;
    if (cat !== 'all' && t.category !== cat) return false;
    if (!q) return true;
    const hay = [t.title, t.place, t.notes, t.dueText, ...(t.people || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

export function statsTodos(todos, now = new Date()) {
  let today = 0, overdue = 0, done = 0, week = 0;
  for (const t of todos) {
    if (t.done) { done++; continue; }
    const d = dueDate(t);
    if (!d) continue;
    const diff = daysBetween(now, d);
    if (diff < 0) overdue++;
    else if (diff === 0) today++;
    if (diff >= 0 && diff <= 6) week++;
  }
  return { total: todos.length, today, overdue, week, done, open: todos.length - done };
}

/** 去重：标题很像、时间一致 -> 视为同一条 */
export function dedupeTodos(todos) {
  const out = [];
  for (const t of todos) {
    const hit = out.find((o) => (o.due || '') === (t.due || '') && similarity(o.title, t.title) >= 0.72);
    if (!hit) out.push(t);
    else {
      hit.notes = [hit.notes, t.notes].filter(Boolean).join('；');
      hit.people = [...new Set([...(hit.people || []), ...(t.people || [])])];
    }
  }
  return out;
}

/* ────────────── 导出 ────────────── */

const CAT_KEYS = Object.keys(CATEGORIES);

export function toMarkdown(todos, now = new Date()) {
  const groups = groupTodos(todos, now);
  const lines = [`# 待办清单`, '', `> 由抽丝生成 · ${fmtDate(now)} · 共 ${todos.length} 条`, ''];
  for (const g of groups) {
    lines.push(`## ${g.title}（${g.count}）`, '');
    for (const t of g.items) {
      const box = t.done ? 'x' : ' ';
      const bits = [];
      if (t.due) bits.push(`🕒 ${dueLabel(t, now)}${t.dueText && t.dueText !== t.title ? `（${t.dueText}）` : ''}`);
      if (t.place) bits.push(`📍 ${t.place}`);
      if (t.people && t.people.length) bits.push(`👤 ${t.people.join('、')}`);
      if (t.priority === 'high') bits.push('❗重要');
      lines.push(`- [${box}] **${t.title}**${bits.length ? ' — ' + bits.join(' · ') : ''}`);
      if (t.notes) lines.push(`  - ${t.notes.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function toPlainText(todos, now = new Date()) {
  const groups = groupTodos(todos, now);
  const lines = [];
  for (const g of groups) {
    lines.push(`【${g.title}】`);
    for (const t of g.items) {
      lines.push(`${t.done ? '[x]' : '[ ]'} ${t.title}${t.due ? '  ⏰' + dueLabel(t, now) : ''}${t.place ? '  📍' + t.place : ''}`);
      if (t.notes) lines.push(`      ${t.notes.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsFold(line) {
  // RFC5545: 75 octets 折行
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

function icsStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

function icsDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function toICS(todos, now = new Date()) {
  const stamp = icsStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//chousi//long-text-to-todo//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:抽丝待办',
  ];
  for (const t of todos) {
    const d = dueDate(t);
    if (!d) continue;
    const isDateOnly = t.precision === 'day' || t.precision === 'month' || t.precision === 'year';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@chousi`);
    lines.push(`DTSTAMP:${stamp}`);
    if (isDateOnly) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(d)}`);
    } else {
      lines.push(`DTSTART:${icsStamp(d)}`);
      const e = t.dueEnd ? fromLocalInput(t.dueEnd) : null;
      const end = e || new Date(d.getTime() + 30 * 60000);
      lines.push(`DTEND:${icsStamp(end)}`);
    }
    const cat = CATEGORIES[t.category] || '其他';
    lines.push(icsFold(`SUMMARY:${icsEscape((t.done ? '✔ ' : '') + t.title)}`));
    if (t.place) lines.push(icsFold(`LOCATION:${icsEscape(t.place)}`));
    const desc = [
      t.deadline ? '【截止时间】' : '',
      t.notes || '',
      t.people && t.people.length ? `相关人：${t.people.join('、')}` : '',
      `分类：${cat}`,
    ].filter(Boolean).join('\n');
    if (desc) lines.push(icsFold(`DESCRIPTION:${icsEscape(desc)}`));
    lines.push(`CATEGORIES:${icsEscape(cat)}`);
    if (t.priority === 'high') lines.push('PRIORITY:1');
    lines.push('STATUS:CONFIRMED');
    if (!isDateOnly) {
      lines.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', icsFold(`DESCRIPTION:${icsEscape(t.title)}`), 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDueFull(todo, now = new Date()) {
  const d = dueDate(todo);
  if (!d) return '';
  const wd = WEEKDAY_NAMES[d.getDay()];
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayPart = `${d.getMonth() + 1}月${d.getDate()}日 周${wd}`;
  if (todo.precision === 'day') return `${dayPart}（全天）`;
  if (todo.precision === 'month') return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  return `${dayPart} ${hm}`;
}

export { toLocalInput };
