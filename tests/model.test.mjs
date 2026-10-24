import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeTodo, groupTodos, filterTodos, statsTodos, dedupeTodos,
  toMarkdown, toICS, toPlainText, dueLabel, isOverdue,
} from '../src/model.js';
import { extract } from '../src/extract.js';

const NOW = new Date(2025, 4, 7, 10, 0, 0);

const mk = (over = {}) => makeTodo({
  title: '开会', due: '2025-05-07T15:00', precision: 'minute', ...over,
});

test('makeTodo 补齐默认值', () => {
  const t = makeTodo({ title: '交周报' });
  assert.equal(t.done, false);
  assert.equal(t.priority, 'normal');
  assert.equal(t.category, 'other');
  assert.ok(t.id);
  assert.ok(t.createdAt);
});

test('makeTodo 清洗非法枚举', () => {
  const t = makeTodo({ title: 'x', priority: 'whatever', category: 'nope' });
  assert.equal(t.priority, 'normal');
  assert.equal(t.category, 'other');
});

test('分组：逾期 / 今天 / 以后 / 无时间 / 已完成', () => {
  const todos = [
    mk({ title: '逾期事', due: '2025-05-01T09:00' }),
    mk({ title: '今天事', due: '2025-05-07T18:00' }),
    mk({ title: '明天事', due: '2025-05-08T09:00' }),
    mk({ title: '下周事', due: '2025-05-19T09:00' }),
    mk({ title: '没时间', due: null, precision: 'none' }),
    mk({ title: '做完了', due: '2025-05-07T08:00', done: true }),
  ];
  const groups = groupTodos(todos, NOW);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items.map((i) => i.title)]));
  assert.deepEqual(byKey.overdue, ['逾期事']);
  assert.deepEqual(byKey.today, ['今天事']);
  assert.deepEqual(byKey.tomorrow, ['明天事']);
  assert.deepEqual(byKey.later, ['下周事']);
  assert.deepEqual(byKey.someday, ['没时间']);
  assert.deepEqual(byKey.done, ['做完了']);
});

test('分组：同组内按时间排序', () => {
  const todos = [
    mk({ title: '晚', due: '2025-05-07T20:00' }),
    mk({ title: '早', due: '2025-05-07T08:00' }),
  ];
  const g = groupTodos(todos, NOW).find((x) => x.key === 'today');
  assert.deepEqual(g.items.map((t) => t.title), ['早', '晚']);
});

test('isOverdue / dueLabel', () => {
  assert.equal(isOverdue(mk({ due: '2025-05-01T09:00' }), NOW), true);
  assert.equal(isOverdue(mk({ due: '2025-05-09T09:00' }), NOW), false);
  assert.equal(isOverdue(mk({ due: '2025-05-01T09:00', done: true }), NOW), false);
  assert.equal(dueLabel(mk({ due: '2025-05-07T15:00' }), NOW), '今天 15:00');
  assert.equal(dueLabel(mk({ due: null }), NOW), '没有时间');
});

test('搜索与分类筛选', () => {
  const a = mk({ title: '提交报销单', category: 'money' });
  const b = mk({ title: '参加周会', category: 'work', place: '会议室' });
  assert.equal(filterTodos([a, b], { q: '报销' }).length, 1);
  assert.equal(filterTodos([a, b], { q: '会议室' }).length, 1);
  assert.equal(filterTodos([a, b], { cat: 'work' }).length, 1);
  assert.equal(filterTodos([a, b], { cat: 'all' }).length, 2);
  assert.equal(filterTodos([a, b], { q: '不存在的' }).length, 0);
});

test('统计', () => {
  const s = statsTodos([
    mk({ due: '2025-05-07T18:00' }),
    mk({ due: '2025-05-01T18:00' }),
    mk({ done: true }),
  ], NOW);
  assert.equal(s.total, 3);
  assert.equal(s.done, 1);
  assert.equal(s.today, 1);
  assert.equal(s.overdue, 1);
});

test('去重：同时间 + 标题高度相似', () => {
  const a = mk({ title: '提交季度报销单', notes: 'A' });
  const b = mk({ title: '提交季度报销单', notes: 'B' });
  assert.equal(dedupeTodos([a, b]).length, 1);
  const c = mk({ title: '完全不相干的事情' });
  assert.equal(dedupeTodos([a, c]).length, 2);
});

test('导出 Markdown', () => {
  const md = toMarkdown([mk({ title: '交周报', notes: '带上电脑', place: '会议室' })], NOW);
  assert.match(md, /^# 待办清单/);
  assert.match(md, /- \[ \] \*\*交周报\*\*/);
  assert.match(md, /📍 会议室/);
  assert.match(md, /带上电脑/);
  assert.match(md, /## 今天/);
});

test('导出纯文本', () => {
  const txt = toPlainText([mk({ title: '交周报' })], NOW);
  assert.match(txt, /【今天】/);
  assert.match(txt, /\[ \] 交周报/);
});

test('导出 ICS：结构合法、无时间的跳过、全天用 VALUE=DATE', () => {
  const todos = [
    mk({ title: '交周报, 含逗号; 含分号', due: '2025-05-07T15:00', precision: 'minute' }),
    mk({ title: '全天的事', due: '2025-05-09T00:00', precision: 'day' }),
    mk({ title: '没有时间的事', due: null, precision: 'none' }),
  ];
  const ics = toICS(todos, NOW);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR/);
  assert.match(ics, /DTSTART:20250507T150000/);
  assert.match(ics, /DTSTART;VALUE=DATE:20250509/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /交周报\\, 含逗号\\; 含分号/);
  // 没有时间的不进日历
  assert.ok(!ics.includes('没有时间的事'));
  // 行长度不超过 75 字节（RFC5545 折行）
  for (const line of ics.split('\r\n')) {
    assert.ok(new TextEncoder().encode(line).length <= 75, 'ICS 行过长：' + line);
  }
});

test('端到端：抽取 → 建待办 → 分组', () => {
  const { items } = extract('明天下午3点在三楼会议室开项目会，记得带电脑', { now: NOW });
  const todos = items.map((it) => makeTodo(it));
  const groups = groupTodos(todos, NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'tomorrow');
  assert.match(todos[0].place, /三楼会议室/);
  assert.match(todos[0].notes, /电脑/);
});
