// tools/probe.mjs —— 抽取探针（常驻开发工具，不是临时脚本）
//
//   node tools/probe.mjs                 跑内置时间语料
//   node tools/probe.mjs "明天下午3点开会"   跑指定文本（抽取全字段）
//
// 用途：改规则前后各跑一次，肉眼对比。固定的断言在 tests/，这里负责"看得见"。
import { findTimes } from '../src/time.js';
import { extract } from '../src/extract.js';

// 固定「现在」：2026-10-24 周六 10:00（与本机时钟一致，看得懂）
const NOW = new Date(2026, 9, 24, 10, 0, 0);

const TIME_CORPUS = [
  // 绝对日期
  '2026年12月1日', '12月1日', '12月1号', '12/1', '12-1', '十二月一日',
  '2027年1月1日', '1月5日', '3月15日',
  // 相对日
  '今天', '明天', '后天', '大后天', '昨天', '前天', '明日', '明早', '明晚', '今晚', '今早', '当天', '次日',
  // 星期
  '周一', '星期二', '礼拜三', '这周五', '本周六', '下周日', '下下周一', '周末',
  // 月 / 年 / 季度
  '本月', '下月', '上个月', '月底', '下月底', '月初', '年初', '明年', '今年年底', '本季度', '下季度',
  // 时刻
  '8点', '8点半', '8点15', '8:15', '8点一刻', '8点三刻', '下午8点', '晚上8点',
  '中午12点', '凌晨1点', '早上7点', '8点整', '24点', '23:59',
  // 区间
  '8:00-10:00', '8点到10点', '8点半到10点半', '8-10点',
  // 相对时长
  '3天后', '3天内', '一周后', '半个月内', '2小时后', '30分钟后',
  // 模糊
  '不久后', '稍后', '尽快',
  // 截止
  '截止日期是12月1日', '12月1日之前', '12月1日以前', '12月1日前',
  // 节日
  '国庆', '国庆前', '五一', '元旦', '春节', '中秋', '圣诞',
  // 中文数字
  '十二月三十一日', '十五号', '二十三点',
  // 组合
  '下周三下午三点半', '明天早上八点一刻', '本周五下班前', '明天下班前',
  // 干扰项（不该被识别成时间）
  '3-5人', '1-2天', '500-800元', '9.5折', '第3周', 'http://x.com/9:30',
];

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

if (process.argv[2]) {
  const text = process.argv.slice(2).join(' ');
  console.log('\n输入：', text, '\n');
  const { items } = extract(text, { now: NOW });
  if (!items.length) console.log('  （抽不到）');
  items.forEach((it, i) => {
    console.log(`  #${i + 1} ${it.title}`);
    console.log(`      due=${it.due || '-'}  end=${it.dueEnd || '-'}  precision=${it.precision}  deadline=${it.deadline}`);
    console.log(`      place=${it.place || '-'}  people=${it.people.join('/') || '-'}  priority=${it.priority}  conf=${it.confidence}`);
    if (it.notes) console.log(`      notes=${it.notes}`);
  });
  console.log('');
  process.exit(0);
}

console.log(`\n时间解析探针   now=${NOW.toString().slice(0, 24)}\n`);
let miss = 0;
for (const s of TIME_CORPUS) {
  const ts = findTimes(s, { now: NOW });
  if (!ts.length) { console.log(pad(s, 22) + '→ (无)'); miss++; continue; }
  const desc = ts.map((t) => {
    if (!t.start) return '模糊';
    const d = t.start;
    const p = (n) => String(n).padStart(2, '0');
    const end = t.end2
      ? `→${p(t.end2.getHours())}:${p(t.end2.getMinutes())}`
      : '';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${end}` +
      `[${t.precision}${t.isDeadline ? ',截止' : ''}]`;
  }).join(' | ');
  console.log(pad(s, 22) + '→ ' + desc);
}
console.log(`\n共 ${TIME_CORPUS.length} 条，未识别 ${miss} 条\n`);
