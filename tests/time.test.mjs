import test from 'node:test';
import assert from 'node:assert/strict';

import { findTimes, parseWhen, describeWhen } from '../src/time.js';
import { toLocalInput } from '../src/util.js';

// 固定「现在」：2025-05-07 周三 10:00
const NOW = new Date(2025, 4, 7, 10, 0, 0);

/** 抽第一个时间点的 due 字符串 */
function due(text) {
  const t = parseWhen(text, { now: NOW });
  return t && t.start ? toLocalInput(t.start) : null;
}

const CASES = [
  // [输入, 期望 due, 说明]
  ['明天上午9点开周会', '2025-05-08T09:00', '相对日 + 上午 + 时刻'],
  ['明天下午3点', '2025-05-08T15:00', '下午换算 24 小时'],
  ['后天下午3点半', '2025-05-09T15:30', '半 = 30 分'],
  ['大后天早上8点出发', '2025-05-10T08:00', '大后天'],
  ['今晚上8点', '2025-05-07T20:00', '今晚'],
  ['下周三下午3点在三楼大会议室开会', '2025-05-14T15:00', '下周三'],
  ['周五下午5点', '2025-05-09T17:00', '裸周五=本周五'],
  ['周一上午10点', '2025-05-12T10:00', '已过去的周一->下周一'],
  ['下下周五', '2025-05-23T00:00', '下下周五'],
  ['本周五上午10点前交报销单', '2025-05-09T10:00', '截止语义'],
  ['6月30日前完成体检', '2025-06-30T00:00', '绝对日期'],
  ['2026年1月1日', '2026-01-01T00:00', '带年份'],
  ['2025-05-09 下午4点面试', '2025-05-09T16:00', 'ISO 日期 + 时刻'],
  ['下个月15号发工资', '2025-06-15T00:00', '下个月 N 号'],
  ['15号前缴费', '2025-05-15T00:00', '本月 N 号'],
  ['5号交房租', '2025-06-05T00:00', '已过的号 -> 下个月'],
  ['月底前提交', '2025-05-31T00:00', '月底'],
  ['三天内回复', '2025-05-10T10:00', '相对时长'],
  ['两个小时后提醒我', '2025-05-07T12:00', '小时级相对时长'],
  ['半小时后出发', '2025-05-07T10:30', '半小时'],
  ['下午两点', '2025-05-07T14:00', '中文数字时刻'],
  ['10点半', '2025-05-07T10:30', '已过的时刻不算明天（15 分钟内）'],
  ['9点一刻', '2025-05-08T09:15', '明显过去的时刻 -> 明天'],
  ['凌晨2点', '2025-05-08T02:00', '凌晨'],
  ['今年年底前完成', '2025-12-31T00:00', '年底'],
];

for (const [input, want, why] of CASES) {
  test(`时间解析：${why} — ${input}`, () => {
    assert.equal(due(input), want);
  });
}

test('时间段：9:00-11:00', () => {
  const t = parseWhen('9:00-11:00 开周会', { now: NOW });
  assert.ok(t);
  assert.equal(toLocalInput(t.start), '2025-05-07T09:00');
  assert.equal(toLocalInput(t.end2), '2025-05-07T11:00');
  assert.equal(t.precision, 'minute');
});

test('时间段：晚上7点半到9点', () => {
  const t = parseWhen('晚上7点半到9点讨论方案', { now: NOW });
  assert.equal(toLocalInput(t.start), '2025-05-07T19:00');
  assert.equal(toLocalInput(t.end2), '2025-05-07T21:00');
});

test('截止语义标记', () => {
  const t = parseWhen('本周五上午10点前交', { now: NOW });
  assert.equal(t.isDeadline, true);
  const t2 = parseWhen('周五上午10点开会', { now: NOW });
  assert.equal(t2.isDeadline, false);
});

test('精度：只有日期时 precision=day', () => {
  assert.equal(parseWhen('周五', { now: NOW }).precision, 'day');
  assert.equal(parseWhen('周五下午3点', { now: NOW }).precision, 'minute');
  assert.equal(parseWhen('下个月', { now: NOW }).precision, 'month');
});

test('不该误判的数字范围', () => {
  assert.equal(findTimes('需要 3-5 人参加', { now: NOW }).length, 0);
  assert.equal(findTimes('持续 1-2 天', { now: NOW }).length, 0);
  assert.equal(findTimes('预算 500-800 元', { now: NOW }).length, 0);
});

test('模糊时间不硬塞日期', () => {
  const all = findTimes('尽快处理一下', { now: NOW });
  assert.equal(all.length, 1);
  assert.equal(all[0].start, null);
  assert.equal(all[0].vague, true);
});

test('一段话里多个时间', () => {
  const all = findTimes('明天上午9点开会，下午3点汇报，周五交材料', { now: NOW });
  assert.equal(all.length, 3);
  assert.equal(toLocalInput(all[0].start), '2025-05-08T09:00');
  assert.equal(toLocalInput(all[1].start), '2025-05-07T15:00');
  assert.equal(toLocalInput(all[2].start), '2025-05-09T00:00');
});

test('原文偏移正确（可高亮）', () => {
  const text = '请于明天上午9点前提交周报';
  const t = parseWhen(text, { now: NOW });
  assert.equal(text.slice(t.index, t.end), t.text);
  assert.equal(t.text, '明天上午9点前');
});

test('describeWhen 人话标签', () => {
  const d = (y, m, day, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi);
  assert.equal(describeWhen(d(2025, 5, 7, 15, 0), { now: NOW }), '今天 15:00');
  assert.equal(describeWhen(d(2025, 5, 8, 9, 0), { now: NOW }), '明天 09:00');
  assert.equal(describeWhen(d(2025, 5, 9), { now: NOW, precision: 'day' }), '后天 全天');
  assert.equal(describeWhen(d(2025, 5, 20), { now: NOW, precision: 'day' }), '5月20日 周二 全天');
  assert.equal(describeWhen(d(2025, 6, 1), { now: NOW, precision: 'month' }), '2025年6月');
  assert.match(describeWhen(d(2025, 5, 1), { now: NOW, precision: 'day' }), /已逾期/);
});
