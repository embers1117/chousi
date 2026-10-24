// 回归测试：这一类 bug 曾经出现过 ——
//   ① 一件事被拆成多条（「4点半结束」自成一条、「签到/正式开始/结束」各一条）
//   ② 地点被当成待办（「地点：三楼会议室」单独成条，标题就叫「地点」）
//   ③ 备注被当成待办（「请携带身份证」单独成条）
// 每一条都对应真实会粘贴的文本。
import test from 'node:test';
import assert from 'node:assert/strict';

import { extract } from '../src/extract.js';

const NOW = new Date(2025, 4, 7, 10, 0, 0); // 周三 10:00
const run = (t) => extract(t, { now: NOW }).items;
const only = (t) => {
  const items = run(t);
  assert.equal(items.length, 1, `应当只有 1 条，实际 ${items.length} 条：` + items.map((i) => i.title).join(' | '));
  return items[0];
};

test('①起止时间：开会 3 点、4 点半结束 -> 1 条，结束时间进 dueEnd', () => {
  const it = only('明天下午3点开会，4点半结束');
  assert.match(it.title, /开会/);
  assert.equal(it.due, '2025-05-08T15:00');
  assert.equal(it.dueEnd, '2025-05-08T16:30');
});

test('①签到流：2点签到、3点开始、5点结束 -> 1 条，14:00-17:00', () => {
  const it = only('明天下午2点签到，3点正式开始，5点结束。');
  assert.match(it.title, /签到/);
  assert.equal(it.due, '2025-05-08T14:00');
  assert.equal(it.dueEnd, '2025-05-08T17:00');
  assert.match(it.notes, /3点正式开始/);
});

test('①集合出发：8点集合、8点半出发 -> 1 条，出发进备注', () => {
  const it = only('周六早上8点在公司门口集合，8点半出发去爬山，记得穿运动鞋');
  assert.match(it.title, /集合/);
  assert.equal(it.due, '2025-05-10T08:00');
  assert.equal(it.place, '公司门口');
  assert.match(it.notes, /出发去爬山/);
  assert.match(it.notes, /运动鞋/);
});

test('②表单三行：时间/地点/内容 -> 1 条，标题取「内容」', () => {
  const it = only('时间：明天下午3点\n地点：三楼会议室\n内容：季度总结会');
  assert.equal(it.title, '季度总结会');
  assert.equal(it.due, '2025-05-08T15:00');
  assert.equal(it.place, '三楼会议室');
});

test('②地点行不会被当成待办', () => {
  const it = only('明天上午9点面试\n地点：人力资源部');
  assert.match(it.title, /面试/);
  assert.equal(it.place, '人力资源部');
});

test('②句中「地点：X」也只是地点', () => {
  const it = only('周五下午3点体检，地点：市第一人民医院。');
  assert.match(it.title, /体检/);
  assert.equal(it.place, '市第一人民医院');
});

test('③续行备注不会被当成待办', () => {
  const it = only('明天上午9点面试\n请携带身份证和两张照片\n地点：人力资源部');
  assert.match(it.title, /面试/);
  assert.match(it.notes, /身份证/);
});

test('③「备注：」行不会单独成条', () => {
  const it = only('本周五前提交报销单。备注：需要部门经理签字。');
  assert.match(it.title, /报销单/);
  assert.match(it.notes, /部门经理签字/);
});

test('③议程行并入会议备注', () => {
  const it = only('下周三下午3点开会。\n会议议程：1. 汇报 2. 讨论');
  assert.match(it.title, /开会/);
  assert.match(it.notes, /汇报/);
});

test('③联系人/电话不产生多余待办', () => {
  const it = only('下周一上午10点开会，联系人：王经理，电话13900001111');
  assert.match(it.title, /开会/);
  assert.deepEqual(it.people.includes('王经理'), true);
  assert.match(it.notes, /13900001111/);
});

test('正常多事件不被误合并：同一行两件事 -> 2 条', () => {
  const items = run('明天上午10点在三楼开会，请带电脑。下午3点交周报。');
  assert.equal(items.length, 2, items.map((i) => i.title).join(' | '));
  const meet = items.find((i) => /开会/.test(i.title));
  const report = items.find((i) => /周报/.test(i.title));
  assert.equal(meet.due, '2025-05-08T10:00');
  assert.match(meet.notes, /电脑/);
  assert.equal(report.due, '2025-05-07T15:00');
});

test('正常多行多事件不被误合并：3 条', () => {
  const items = run('记得买牛奶\n明天下午5点取快递\n周五前交周报');
  assert.equal(items.length, 3, items.map((i) => i.title).join(' | '));
  const byKw = (kw) => items.find((i) => i.title.includes(kw));
  assert.equal(byKw('牛奶').due, null);
  assert.equal(byKw('快递').due, '2025-05-08T17:00');
  assert.equal(byKw('周报').due, '2025-05-09T00:00');
});

test('只有时间和地点没有任务时，不硬造待办', () => {
  assert.deepEqual(run('时间：明天上午9点\n地点：线上腾讯会议'), []);
});

test('抬头不会变成一条叫「同事」的待办', () => {
  const items = run('【部门通知】各位同事：下周三下午3点开会。');
  assert.equal(items.length, 1);
  assert.match(items[0].title, /开会/);
  assert.ok(!items.some((i) => i.title === '同事'));
});

test('整段通知：4 条，标题里不出现「地点」「结束」这类碎片', () => {
  const text = `【部门通知】各位同事：下周三下午3点在三楼大会议室召开第二季度工作总结会，请各部门负责人提前准备汇报材料，务必准时参加。

另外，请于本周五上午10点前把本部门上季度的报销单据交到行政部小张处，逾期不再受理。

还有，明天中午12点半公司食堂有团建聚餐，记得带工牌。

最后提醒一下，6月30日前完成年度体检预约，体检地点是市第一人民医院体检中心，联系李医生（电话13800138000）。`;
  const items = run(text);
  assert.equal(items.length, 4, items.map((i) => i.title).join(' | '));
  for (const bad of ['地点', '时间', '备注', '结束', '同事', '内容']) {
    assert.ok(!items.some((i) => i.title === bad), `不该出现标题「${bad}」`);
  }
});
