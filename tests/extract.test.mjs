import test from 'node:test';
import assert from 'node:assert/strict';

import { extract } from '../src/extract.js';

const NOW = new Date(2025, 4, 7, 10, 0, 0); // 周三 10:00

const NOTICE = `【部门通知】各位同事：下周三下午3点在三楼大会议室召开第二季度工作总结会，请各部门负责人提前准备汇报材料，务必准时参加。

另外，请于本周五上午10点前把本部门上季度的报销单据交到行政部小张处，逾期不再受理。

还有，明天中午12点半公司食堂有团建聚餐，记得带工牌。

最后提醒一下，6月30日前完成年度体检预约，体检地点是市第一人民医院体检中心，联系李医生（电话13800138000）。`;

const run = (text) => extract(text, { now: NOW }).items;

test('通知类长文：抽出 4 条待办', () => {
  const items = run(NOTICE);
  assert.equal(items.length, 4, '应抽出 4 条，实际：' + items.map((i) => i.title).join(' | '));
});

test('通知类长文：每条的时间都解析正确', () => {
  const items = run(NOTICE);
  const dueOf = (kw) => {
    const it = items.find((i) => i.title.includes(kw));
    assert.ok(it, `没找到包含「${kw}」的待办：${items.map((i) => i.title).join(' | ')}`);
    return it;
  };
  assert.equal(dueOf('总结会').due, '2025-05-14T15:00');
  assert.equal(dueOf('报销').due, '2025-05-09T10:00');
  assert.equal(dueOf('报销').deadline, true);
  assert.equal(dueOf('聚餐').due, '2025-05-08T12:30');
  assert.equal(dueOf('体检').due, '2025-06-30T00:00');
});

test('通知类长文：地点 / 人物 / 备注', () => {
  const items = run(NOTICE);
  const meeting = items.find((i) => i.title.includes('总结会'));
  assert.equal(meeting.place, '三楼大会议室');
  assert.ok(/汇报材料/.test(meeting.notes), '开会那条的备注里应有汇报材料，实际：' + meeting.notes);

  const health = items.find((i) => i.title.includes('体检'));
  assert.match(health.place, /人民医院/);
  assert.ok(health.people.includes('李医生'), '应识别李医生，实际：' + health.people);

  const dinner = items.find((i) => i.title.includes('聚餐'));
  assert.ok(/工牌/.test(dinner.notes), '聚餐那条应提示带工牌，实际：' + dinner.notes);
});

test('编号清单：一条一行，各自成条', () => {
  const text = `1. 明天上午9点提交周报给张老师
2. 下周一去银行办理贷款手续，带上身份证和工资流水
3. 周五晚上7点和客户吃饭`;
  const items = run(text);
  assert.equal(items.length, 3, items.map((i) => i.title).join(' | '));
  const by = (kw) => {
    const it = items.find((i) => i.title.includes(kw));
    assert.ok(it, `没找到「${kw}」：${items.map((i) => i.title).join(' | ')}`);
    return it;
  };
  assert.equal(by('周报').due, '2025-05-08T09:00');
  assert.equal(by('贷款').due, '2025-05-12T00:00');
  assert.equal(by('吃饭').due, '2025-05-09T19:00');
  assert.match(by('贷款').notes, /身份证/);
  // 抽取结果按时间先后排序
  assert.deepEqual(items.map((i) => i.due), ['2025-05-08T09:00', '2025-05-09T19:00', '2025-05-12T00:00']);
});

test('没有时间的碎句子也能成条', () => {
  const items = run('记得买牛奶');
  assert.equal(items.length, 1);
  assert.equal(items[0].due, null);
  assert.match(items[0].title, /牛奶/);
  assert.equal(items[0].category, 'life');
});

test('线上会议：识别会议号', () => {
  const items = run('9:00-11:00 在腾讯会议（会议号 123-456-789）开项目复盘会');
  assert.equal(items.length, 1);
  assert.equal(items[0].due, '2025-05-07T09:00');
  assert.match(items[0].place, /腾讯会议/);
  assert.match(items[0].place, /123-456-789/);
});

test('一句话两件事：拆成两条', () => {
  const items = run('下周三下午3点在三楼大会议室开季度总结会，本周五上午10点前把报销单交给行政部小张。');
  assert.equal(items.length, 2, items.map((i) => i.title).join(' | '));
  const a = items.find((i) => i.title.includes('总结会'));
  const b = items.find((i) => i.title.includes('报销'));
  assert.equal(a.place, '三楼大会议室');
  assert.equal(b.deadline, true);
  assert.ok(b.people.includes('小张'), '应识别小张，实际：' + b.people);
});

test('重复描述会合并', () => {
  const items = run('明天上午9点开周会。明天上午9点开周会。');
  assert.equal(items.length, 1);
});

test('优先级与分类', () => {
  const items = run('务必在明天下午3点前把紧急方案发给客户');
  assert.equal(items[0].priority, 'high');
  const it2 = run('下周一去医院挂号看病')[0];
  assert.equal(it2.category, 'health');
});

test('原文出处可以定位回原文片段', () => {
  const items = run('本周五上午10点前把报销单交给行政部小张');
  const it = items[0];
  assert.ok(it.source.text.length > 0);
  const dueMark = it.source.marks.find((m) => m.field === 'due');
  assert.ok(dueMark, '应有一条 due 标记');
  const covered = it.source.text.slice(dueMark.start, dueMark.end);
  assert.match(covered, /本周五/);
});

test('空文本不炸', () => {
  assert.deepEqual(run(''), []);
  assert.deepEqual(run('   \n\n  '), []);
});

test('置信度在 0~1 之间且有时间更高', () => {
  const withDue = run('明天下午3点开会')[0];
  const noDue = run('随便写点什么吧')[0];
  assert.ok(withDue.confidence > 0 && withDue.confidence <= 1);
  assert.ok(withDue.confidence > noDue.confidence);
});

test('全角数字和奇怪空白也能处理', () => {
  const items = run('明天下午３点开会');
  assert.equal(items[0].due, '2025-05-08T15:00');
});
