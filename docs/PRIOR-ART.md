# 同类项目调研（prior art）

> 2026-10 做过一轮 GitHub 调研，目的是确认「长文本 → 多字段待办」这个方向有没有现成的轮子可借、
> 有没有人已经占了位。结论和数据都记在这里，省得以后再查一遍。

## 结论先行

**GitHub 上没有正面对位「粘贴一段长文本 → 抽出多条结构化的待办（时间/地点/人物/备注）」的项目。**

这个需求被劈成了两条线，两边都不做我们做的事：

- **会议侧**：录音 → 转录 → 摘要，`action items` 只是摘要里的一个 bullet 列表，不落到带字段的待办
- **邮件侧**：批量处置收件箱，落点是「归档 / 回复 / 退订」，不是结构化任务
- **中文侧**：几乎空白。查到的都是 0–几十 star 的新号验证品、或 MCP/skill 封装的薄壳

## 同类项目

| 项目 | star | 语言 | 路线 | 与本项目的关系 |
|---|---|---|---|---|
| [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) | 32k | Python+TS | Whisper + LLM | 会议录音→纪要；action items 只是摘要 bullet。**不做、也不该做**——工程重且已占位 |
| [Super Productivity](https://github.com/johannesjo/super-productivity) | 23k | TypeScript | 规则（quick-add 短语法） | 只解析**单行**输入的时长/标签/截止，没有长文多任务抽取 |
| [Inbox Zero](https://github.com/elie222/inbox-zero) | 13k | TypeScript | LLM（Gmail） | 邮件批量处置，落点不是待办字段 |
| [Hyprnote](https://github.com/fastrepl/hyprnote) | 9.6k | Rust+TS | 本地 LLM | 本地优先会议笔记，摘要为主 |
| [Duckling](https://github.com/facebook/duckling) | 4.3k | Haskell | 规则（grammar） | 中文时间实体解析器 + 官方语料；**语料可抄，代码不可用**（Haskell 服务） |
| [Scriberr](https://github.com/rishikanthc/Scriberr) | 3.1k | TS/Svelte | Whisper + LLM | 自托管转录→摘要 |
| [chrono-node](https://github.com/wanasit/chrono) | 5.3k | TypeScript | 规则 | JS 日期解析的事实标准，中文只有 7 个 parser |
| [chinese-days](https://github.com/vsme/chinese-days) | 1.3k | TypeScript | 数据表 | 节假日/调休/节气/农历 |
| [lunar-javascript](https://github.com/6tail/lunar-javascript) | 1.7k | JavaScript | 数据表 | 农历/干支/传统节日换算 |

## 一、为什么没换掉自研的时间解析器

对比完反而更确定了：

| | 我们的 `src/time.js` | chrono-node 中文 | Duckling 中文 |
|---|---|---|---|
| 相对日 / 星期 / 月份周期 | ✅ | 部分 | ✅ |
| **时间区间**（9:00-11:00、7点半到9点） | ✅ | ❌ | 部分 |
| **截止语义**（本周五前 → deadline） | ✅ | 有单独 parser | ✅ |
| **相对时长**（三天内、半小时后） | ✅ | ❌ | 部分 |
| 节日（国庆/春节/中秋） | ✅ | ❌ | ❌ |
| 运行时依赖 | **0** | 1 个包（3.2MB 整包） | Haskell 服务 |
| 结果自带字符偏移（做原文高亮） | ✅ | ✅ | ❌ |

「零依赖 + 离线可用」是本项目唯一的叙事支点，为几个 parser 引入 3MB 依赖不划算。
但 chrono 的 `{ index, text, start, end }` 结果契约值得对齐——我们的 `findTimes()` 返回的
`{ index, end, text, start, end2, precision, isDeadline }` 就是同一套思路，这块已经对上了。

**Duckling 的中文语料**（[`Time/ZH/Corpus.hs`](https://github.com/facebook/duckling/blob/main/Duckling/Time/ZH/Corpus.hs)）
是唯一值得抄的东西：几百条「中文表达 → ISO 时间」的期望值，可以拿来扩我们的时间单测。
这一步还没做，列在下面。

## 二、本轮调研实际采纳了什么

1. **节日支持**（`src/time.js`）：固定节日 + 农历节日年度表（2025–2027）。
   顺带做了「节日 + 前 = 节前一天」（国庆前 → 9/30），这是中文通知里极常见的截止表达。
2. **准确率报表**（`tools/eval.mjs`）：调研确认**这个任务没有公开基准**——字段级 F1 没人做。
   既然没有，就自己建一套最小可用的：14 条真实语料，逐条比对 条数/时间/标题/地点/备注/人物，
   输出多抽漏抽统计，CI 里以 `--strict` 卡阈值。
3. **确认定位**：不做 ASR、不做会议录制、不做「LLM 优先」的纯黑盒——那会把唯一差异抹掉。

## 三、还没做、但值得做

- [ ] 从 Duckling ZH Corpus 摘 50–100 条中文时间表达，扩 `tests/time.test.mjs`
- [ ] 卡片上显示「命中了哪条规则」（`下周三` → 10-29 周二 15:00 这种可解释性提示）
- [ ] 疑似重复折叠（同时间 + 近义标题 → 「疑似重复 N 条」，而不是静默合并）
- [ ] 键盘流：`j/k` 上下、`Enter` 加入待办，几十条时比鼠标快一个量级
- [ ] 节假日/调休（`chinese-days` 那份数据）：需要每年跟版，暂不引入

## 四、评测参考

- [QMSum](https://github.com/Yale-LILY/QMSum)：会议摘要/问答，可借「怎么切语料」的思路
- AMI / ICSI 语料：action item 抽取论文的事实标准，但标注的是「哪句算 action item」，
  不是字段值——和我们要衡量的东西只对一半
- 指标惯例：任务级 P/R/F1 + due 字段 exact-match。我们的 `eval.mjs` 用的是后者 + 条数准确率
