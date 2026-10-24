// tools/eval.mjs —— 抽取准确率评估（不是断言测试，是打分报表）
//
//   node tools/eval.mjs            打印报表
//   node tools/eval.mjs --strict   低于阈值时退出码 1（CI 可用）
//
// 与 tests/ 的区别：单测是「这个用例必须这样」，评估是「在一批真实语料上，
// 条数/时间/地点/备注 各对了多少」，用来量化改动到底让效果变好还是变差。
import { extract } from '../src/extract.js';
import { findTimes } from '../src/time.js';
import { similarity } from '../src/util.js';

const NOW = new Date(2025, 4, 7, 10, 0, 0); // 周三 10:00

// 每条语料：期望抽出的待办（只写必须对的字段，title 用「包含」匹配）
const CASES = [
  {
    name: 'A 起止时间',
    text: '明天下午3点开会，4点半结束',
    expect: [{ title: '开会', due: '2025-05-08T15:00', dueEnd: '2025-05-08T16:30' }],
  },
  {
    name: 'B 表单三行',
    text: '时间：明天下午3点\n地点：三楼会议室\n内容：季度总结会',
    expect: [{ title: '季度总结会', due: '2025-05-08T15:00', place: '三楼会议室' }],
  },
  {
    name: 'C 面试带材料',
    text: '明天上午9点面试。请携带身份证、毕业证和两张照片。',
    expect: [{ title: '面试', due: '2025-05-08T09:00', notes: '身份证' }],
  },
  {
    name: 'D 备注行',
    text: '本周五前提交报销单。备注：需要部门经理签字。',
    expect: [{ title: '报销单', due: '2025-05-09T00:00', notes: '签字' }],
  },
  {
    name: 'E 地点冒号',
    text: '周五下午3点体检，地点：市第一人民医院。',
    expect: [{ title: '体检', due: '2025-05-09T15:00', place: '市第一人民医院' }],
  },
  {
    name: 'F 同一行两件事',
    text: '明天上午10点在三楼开会，请带电脑。下午3点交周报。',
    expect: [
      { title: '开会', due: '2025-05-08T10:00', notes: '电脑' },
      { title: '周报', due: '2025-05-07T15:00' },
    ],
  },
  {
    name: 'G 签到流',
    text: '明天下午2点签到，3点正式开始，5点结束。',
    expect: [{ title: '签到', due: '2025-05-08T14:00', dueEnd: '2025-05-08T17:00' }],
  },
  {
    name: 'H 议程行',
    text: '下周三下午3点开会。\n会议议程：1. 汇报 2. 讨论',
    expect: [{ title: '开会', due: '2025-05-14T15:00', notes: '汇报' }],
  },
  {
    name: 'I 部门通知（4 件）',
    text: `【部门通知】各位同事：下周三下午3点在三楼大会议室召开第二季度工作总结会，请各部门负责人提前准备汇报材料，务必准时参加。

另外，请于本周五上午10点前把本部门上季度的报销单据交到行政部小张处，逾期不再受理。

还有，明天中午12点半公司食堂有团建聚餐，记得带工牌。

最后提醒一下，6月30日前完成年度体检预约，体检地点是市第一人民医院体检中心，联系李医生（电话13800138000）。`,
    expect: [
      { title: '总结会', due: '2025-05-14T15:00', place: '三楼大会议室' },
      { title: '报销', due: '2025-05-09T10:00', people: '小张' },
      { title: '聚餐', due: '2025-05-08T12:30', notes: '工牌' },
      { title: '体检', due: '2025-06-30T00:00', place: '人民医院' },
    ],
  },
  {
    name: 'J 集合出发',
    text: '周六早上8点在公司门口集合，8点半出发去爬山，记得穿运动鞋',
    expect: [{ title: '集合', due: '2025-05-10T08:00', place: '公司门口', notes: '运动鞋' }],
  },
  {
    name: 'K 多行续写',
    text: '明天上午9点面试\n请携带身份证和两张照片\n地点：人力资源部',
    expect: [{ title: '面试', due: '2025-05-08T09:00', place: '人力资源部', notes: '身份证' }],
  },
  {
    name: 'L 联系人与电话',
    text: '下周一上午10点开会，联系人：王经理，电话13900001111',
    expect: [{ title: '开会', due: '2025-05-12T10:00', people: '王经理' }],
  },
  {
    name: 'M 三行独立任务',
    text: '记得买牛奶\n明天下午5点取快递\n周五前交周报',
    expect: [
      { title: '牛奶', due: null },
      { title: '快递', due: '2025-05-08T17:00' },
      { title: '周报', due: '2025-05-09T00:00' },
    ],
  },
  {
    name: 'N 编号清单',
    text: '1. 明天上午9点提交周报给张老师\n2. 下周一去银行办理贷款手续，带上身份证和工资流水\n3. 周五晚上7点和客户吃饭',
    expect: [
      { title: '周报', due: '2025-05-08T09:00' },
      { title: '贷款', due: '2025-05-12T00:00', notes: '身份证' },
      { title: '吃饭', due: '2025-05-09T19:00' },
    ],
  },
];

/* ────────────── 比对 ────────────── */

function scorePair(exp, got) {
  let s = 0;
  if ((exp.due || null) === (got.due || null)) s += 2;
  if (exp.title && got.title && (got.title.includes(exp.title) || similarity(exp.title, got.title) >= 0.5)) s += 2;
  if (exp.place && got.place && (got.place.includes(exp.place) || exp.place.includes(got.place))) s += 1;
  return s;
}

const fields = ['due', 'title', 'place', 'dueEnd', 'notes', 'people'];

function check(exp, got) {
  const r = {};
  r.due = (exp.due === undefined) ? null : (exp.due || null) === (got.due || null);
  r.title = !exp.title || (got.title || '').includes(exp.title) || similarity(exp.title, got.title) >= 0.5;
  r.place = !exp.place || (got.place || '').includes(exp.place) || (exp.place || '').includes(got.place || '#');
  r.dueEnd = !exp.dueEnd || (got.dueEnd || '') === exp.dueEnd;
  r.notes = !exp.notes || (got.notes || '').includes(exp.notes);
  r.people = !exp.people || (got.people || []).some((p) => p.includes(exp.people) || exp.people.includes(p));
  return r;
}

const mark = (v) => (v === null ? '·' : v ? '✓' : '✗');

let totals = { cases: 0, countOk: 0, exact: 0, extra: 0, missing: 0 };
const fieldStats = Object.fromEntries(fields.map((f) => [f, { ok: 0, n: 0 }]));
const rows = [];

for (const c of CASES) {
  const items = extract(c.text, { now: NOW }).items;
  const used = new Set();
  const results = [];
  let missing = 0;

  for (const exp of c.expect) {
    let best = -1, bestScore = -1;
    items.forEach((got, i) => {
      if (used.has(i)) return;
      const s = scorePair(exp, got);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best < 0) { missing++; results.push(null); continue; }
    used.add(best);
    results.push({ got: items[best], chk: check(exp, items[best]) });
  }

  const extra = items.length - used.size;
  const countOk = extra === 0 && missing === 0;
  const perField = {};
  for (const f of fields) {
    let ok = 0, n = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.chk[f] === null) continue;
      n++; if (r.chk[f]) ok++;
    }
    perField[f] = { ok, n };
    fieldStats[f].ok += ok;
    fieldStats[f].n += n;
  }

  totals.cases++;
  if (countOk) totals.countOk++;
  totals.extra += Math.max(0, extra);
  totals.missing += missing;
  if (countOk && results.every((r) => r && Object.values(r.chk).every((v) => v !== false))) totals.exact++;

  rows.push({
    name: c.name,
    count: `${items.length}/${c.expect.length}`,
    ok: countOk,
    extra,
    missing,
    perField,
  });
}

function pad(s, n) {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

console.log('\n抽丝 · 抽取准确率评估   语料 ' + totals.cases + ' 条   now=' + NOW.toString().slice(0, 24) + '\n');
console.log(pad('用例', 22) + pad('条数', 8) + pad('时间', 6) + pad('标题', 6) + pad('地点', 6) + '备注  其他');
console.log('─'.repeat(72));
for (const r of rows) {
  const cell = (f) => (r.perField[f].n ? mark(r.perField[f].ok === r.perField[f].n) : '·');
  console.log(
    pad(r.name, 22) + pad(`${r.count}${r.ok ? '' : ' ✗'}`, 8) + pad(cell('due'), 6) + pad(cell('title'), 6) +
    pad(cell('place'), 6) + `${cell('notes')}    ${cell('dueEnd')}${cell('people') === '·' ? '' : ' ' + cell('people')}`
  );
}
console.log('─'.repeat(72));

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
console.log(
  `条数完全正确  ${totals.countOk}/${totals.cases} (${pct(totals.countOk, totals.cases)})` +
  `   多抽 ${totals.extra} 条 / 漏抽 ${totals.missing} 条` +
  `   全字段正确 ${totals.exact}/${totals.cases}`
);
console.log(
  fields.filter((f) => fieldStats[f].n)
    .map((f) => `${f} ${pct(fieldStats[f].ok, fieldStats[f].n)}`)
    .join('   ')
);

const ok = totals.countOk / totals.cases >= 0.9 && fields.filter((f) => f === 'due')
  .every((f) => fieldStats[f].ok / fieldStats[f].n >= 0.9);
if (process.argv.includes('--strict') && !ok) {
  console.error('\n❌ 低于阈值（条数 ≥90% 且 时间 ≥90%）');
  process.exit(1);
}
console.log(ok ? '\n✅ 达标（条数 ≥90% 且 时间 ≥90%）\n' : '\n⚠️ 未达标\n');
