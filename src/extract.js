// src/extract.js —— 抽取流水线（v2 分段器）
//
//   原文 → 归一化 → 切行 → 切句 → 归类（属性行 / 任务句 / 续写句 / 连接词）
//        → 聚合成「事件」→ 合并续写时间（签到/结束/出发…）→ 逐字段抽取 → 合并去重 → 置信度
//
// v1 的错误：把「含时间锚点的分句」直接当成一件待办，于是
//   · 「4点半结束」→ 多出一条叫「结束」的待办
//   · 「地点：三楼会议室」单独一行 → 多出一条叫「地点」的待办
//   · 「明天9点面试 / 请携带身份证」→ 备注变成独立待办
// v2 改为：先判「这句是任务还是属性/续写」，属性与续写只会被挂到所属事件上。
//
// 一条 item:
//   { title, due, dueText, dueEnd, precision, deadline, place, people, phones,
//     notes, priority, category, confidence, weak, source:{text,marks} }

import { normalize, tidy, truncate, similarity, clamp, toLocalInput } from './util.js';
import { findTimes, describeWhen } from './time.js';
import {
  findPlace, findPeople, findPriority, findCategory, findNoteHints,
  hasAction, blankSpans,
} from './fields.js';

const MAX_TITLE = 42;

/* ────────────── 切分 ────────────── */

/** 按行切块，保留偏移 */
export function splitBlocks(text) {
  const out = [];
  const re = /[^\n\r]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    out.push({ start: m.index, end: m.index + raw.length, text: raw });
  }
  return out;
}

const CLAUSE_DELIM = '，。；！？,;!?、';

/** 按标点切句（冒号只在非数字之间切，避免把 9:30 切开） */
export function splitClauses(text, start = 0, end = text.length) {
  const out = [];
  let s = start;
  const isNum = (c) => c != null && /[0-9]/.test(c);
  for (let i = start; i < end; i++) {
    const c = text[i];
    let cut = CLAUSE_DELIM.includes(c);
    if (!cut && (c === '：' || c === ':')) cut = !isNum(text[i - 1]) && !isNum(text[i + 1]);
    if (cut) {
      if (i > s) out.push({ start: s, end: i, text: text.slice(s, i) });
      s = i + 1;
    }
  }
  if (end > s) out.push({ start: s, end, text: text.slice(s, end) });
  return out;
}

/** 去掉行首的列表符号：1. / 1、/ （1）/ ① / - / • / 一、 */
export function stripListMarker(block) {
  const re = /^\s*(?:[（(]?\d{1,2}[.、)）]|[①-⑳]|[一二三四五六七八九十]{1,2}[、.]|[-*•·●▪—])\s*/;
  const m = block.text.match(re);
  if (!m) return block;
  const start = block.start + m[0].length;
  return { start, end: block.end, text: block.text.slice(m[0].length) };
}

/* ────────────── 句子归类 ────────────── */

/** 「键：值」表单行 —— 这类行是属性，不是待办 */
const ATTR_KEYS = [
  [/^(时间|日期|时间安排|开始时间|签到时间|会议时间|集合时间|活动时间)$/, 'time'],
  [/^(地点|地址|场地|会议地点|集合地点|开会地点|地点安排|举办地点)$/, 'place'],
  [/^(内容|主题|议题|事项|活动|项目|会议主题|会议名称|主题内容|活动名称|事由)$/, 'title'],
  [/^(备注|要求|注意|注意事项|须知|说明|携带|携带物品|准备|准备事项|温馨提示)$/, 'note'],
  [/^(联系人|负责人|联系电话|电话|联系方式|联系人电话|咨询电话)$/, 'contact'],
  [/^(议程|会议议程|流程|会议流程|安排|会议安排)$/, 'note'],
];

function attrKindOf(key) {
  for (const [re, kind] of ATTR_KEYS) if (re.test(key)) return kind;
  return null;
}

/** 活动名词：用来给「会议时间：… 会议地点：…」这种没有正文的表单兜底出标题 */
const KEY_TITLE_RE = /(会议|面试|培训|活动|聚餐|考试|体检|讲座|答辩|评审|汇报|签约|出差|团建|体检)/;

/**
 * 「键：值」表单行（一行里可以有多组）。
 * 这类行是属性，不是待办：时间/地点/内容/备注/联系人/议程
 */
function matchAttrLine(line) {
  const s = line.text;
  const re = /([^：:\s]{1,8})\s*[:：]/g;
  const pairs = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[1].trim();
    const kind = attrKindOf(key);
    if (!kind) continue;
    pairs.push({ kind, key, keyIndex: m.index, valueStart: m.index + m[0].length });
  }
  if (!pairs.length) return [];
  if (pairs[0].keyIndex > 2) return [];   // 必须从行首开始，行中间的不算表单
  return pairs.map((p, i) => {
    const stop = i + 1 < pairs.length ? pairs[i + 1].keyIndex : s.length;
    const raw = s.slice(p.valueStart, stop);
    const value = raw.trim();
    const lead = raw.length - raw.trimStart().length;
    return {
      attr: p.kind,
      key: p.key,
      text: value,
      start: line.start + p.valueStart + lead,
      end: line.start + p.valueStart + lead + value.length,
    };
  }).filter((p) => p.text);
}

/** 纯过渡词，出现即丢弃 */
const CONNECTOR_ONLY = /^(另外|还有|此外|同时|以及|然后|接着|接下来|最后|补充一下|补充|再说|顺便|另|附|ps|PS)[\s,，。:：吧了。！!]*$/;
const FILLER_ONLY = /^(最后提醒一下|提醒一下|再提醒一下|特此通知|请知悉|请转发|请相互转告|周知|收到|好的|嗯+|ok|谢谢|各位同事|各位同学|各位|大家好|同学们|同事们)[\s,，。:：吧了。！!]*$/i;

/** 续写句：这句话只是给上一件事补一个时间点（结束/开始/签到/出发…） */
const CONT_RE = /^(结束|散会|完毕|闭会|截止|签退|离场|正式开始|开始|开场|签到|入场|进场|报到|集合|出发|到场|到|结束时间|上课|下课|散场|离席)/;

/** 以这些词开头的行，多半是上一条待办的补充说明，而不是新待办 */
const NOTE_LEAD = /^(请|麻烦|记得|别忘了|别忘|务必|一定要|需要|还需|请携带|携带|带上|自带|注意|备注|要求|不要|切勿|最好|建议|逾期|否则|费用|材料|附件|详见|如需|如果|若|凭|按|每人|每位)/;

const INSTRUCTION = /(请|务必|记得|别忘|需要|麻烦|要求)/;

/** 抬头句：不该单独成待办，应该被后面的事件吸收 */
function isHeaderClause(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  const core = s.replace(/[\s，,。、；;：:]/g, '');
  if (core.length > 16) return false;
  if (/[【】]/.test(s)) return true;
  return /(通知|公告|须知|关于|各位|大家|同事|同学|抬头|主题)/.test(s) && !/^(买|取|交|发|写|打|做|去|来)/.test(core);
}

/** 句子去掉时间片段后的「实义文本」 */
function meaningful(text) {
  return blankSpans(text, findTimes(text).map((t) => ({ index: t.index, end: t.end })))
    .replace(/[\s，,、。：:；;]/g, '');
}

const isConnector = (t) => CONNECTOR_ONLY.test(t.trim()) || FILLER_ONLY.test(t.trim());

/** 任务句：有动作动词，或带祈使语气 */
const isTaskClause = (t) => hasAction(t) || INSTRUCTION.test(t);

/** 续写句判定（不含时间的那部分只有 12 字以内且以「结束/出发/签到」等开头） */
function isContinuation(text) {
  const t = meaningful(text);
  if (!t) return true;
  if (t.length > 14) return false;
  return CONT_RE.test(t);
}

/** 一行里塞了多件事时常见的内联编号：`1、A 2、B` / `(1) A (2) B` */
export function splitInlineEnum(text) {
  const re = /(\d{1,2}|[一二三四五六七八九十]{1,2})\s*[、．.)）]\s*/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = m.index > 0 ? text[m.index - 1] : '';
    const after = text[m.index + m[0].length];
    if (before && !/[\s，,；;。]/.test(before)) continue;   // 必须紧跟行首/空白/标点（排除 9.5 倍）
    if (!after || !/[\u4e00-\u9fa5A-Za-z]/.test(after)) continue;
    marks.push({ start: m.index, end: m.index + m[0].length });
  }
  if (!marks.length) return [{ start: 0, end: text.length }];
  const out = [];
  let from = 0;
  for (const mk of marks) {
    if (mk.start > from && text.slice(from, mk.start).trim()) out.push({ start: from, end: mk.start });
    from = mk.end;
  }
  if (text.slice(from).trim()) out.push({ start: from, end: text.length });
  return out.length ? out : [{ start: 0, end: text.length }];
}

/* ────────────── 事件聚合 ────────────── */

function newEvent(lineIdx) {
  return {
    clauses: [],
    times: [],
    lineIdx,
    start: Infinity,
    end: -1,
    place: '',
    forcedTitle: null,
    keyHint: null,      // 「会议时间：…」里的「会议」，没有正文时兜底标题
    noteHints: [],
    dueEndTime: null,   // 续写里「X点结束」的解析结果
    weak: false,
  };
}

function touch(ev, start, end) {
  ev.start = Math.min(ev.start, start);
  ev.end = Math.max(ev.end, end);
}

/**
 * 把整段文本聚合成事件数组。
 * 关键规则：
 *   1. 表单属性行（时间/地点/内容/备注/联系人）永远挂到当前事件，不自成一条
 *   2. 续写句（4点半结束、3点签到、8点半出发）挂到当前事件，结束时间进 dueEnd
 *   3. 只有「含时间 且 是任务句」才开新事件；跨行时「请/记得/携带…」开头算续写
 */
export function segment(text, now) {
  const events = [];
  let cur = null;
  let pending = [];   // 第一个事件之前出现的散句（多半是标题抬头）

  const flush = () => {
    if (cur) events.push(cur);
    cur = null;
  };
  /** 没有事件可挂的句子：像抬头的留在 pending 里等下一个事件，否则自成一条 */
  const flushPending = () => {
    if (!pending.length) return;
    // 纯人名/纯符号/2 字的残句不配单独成条（「王总：明天3点开会」里的「王总」）
    const usable = pending.filter((p) => {
      const s = p.text.trim();
      if (isHeaderClause(s)) return false;
      if (hasAction(s)) return true;
      return s.replace(/[\s，,。、；;：:]/g, '').length >= 4;
    });
    if (usable.length) {
      const ev = newEvent(usable[0].lineIdx || 0);
      for (const p of usable) { ev.clauses.push(p); touch(ev, p.start, p.end); }
      events.push(ev);
    }
    pending = [];
  };
  const open = (lineIdx) => {
    flush();
    if (pending.length && !pending.every((p) => isHeaderClause(p.text))) flushPending();
    cur = newEvent(lineIdx);
    if (pending.length) {
      cur.clauses.push(...pending);
      for (const p of pending) touch(cur, p.start, p.end);
      pending = [];
    }
    return cur;
  };

  const applyAttr = (a, lineIdx) => {
    if (a.attr === 'time' && a.text) {
      const ts = findTimes(a.text, { now });
      if (ts.length) {
        if (!cur) open(lineIdx);
        for (const t of ts) {
          cur.times.push({ ...t, index: t.index + a.start, end: t.end + a.start });
        }
        if (KEY_TITLE_RE.test(a.key) && !cur.keyHint) {
          cur.keyHint = a.key.match(KEY_TITLE_RE)[1];
        }
        if (!cur.place && /(地点|地址|场地)/.test(a.key)) cur.place = a.text;
        touch(cur, a.start, a.end);
        return;
      }
    }
    if (!cur) open(lineIdx);
    if (a.attr === 'place') cur.place = cur.place || a.text;
    else if (a.attr === 'title') cur.forcedTitle = cur.forcedTitle || a.text;
    else if (a.attr === 'contact') {
      if (KEY_TITLE_RE.test(a.key) && !cur.keyHint) cur.keyHint = a.key.match(KEY_TITLE_RE)[1];
      // 带手机号的「联系人：王小姐 138…」不塞进备注，号码末尾统一加
      if (!/(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})/.test(a.text)) cur.noteHints.push(a.text);
    } else {
      if (!cur.keyHint && KEY_TITLE_RE.test(a.key)) cur.keyHint = a.key.match(KEY_TITLE_RE)[1];
      cur.noteHints.push(a.text);
    }
    touch(cur, a.start, a.end);
  };

  for (const [lineIdx, rawLine] of splitBlocks(text).entries()) {
    if (!rawLine.text.trim()) continue;
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(rawLine.text)) continue;
    const line = stripListMarker(rawLine);

    // ① 表单属性行（一行里可能有多组「键：值」）
    const attrs = matchAttrLine(line);
    if (attrs.length) { for (const a of attrs) applyAttr(a, lineIdx); continue; }

    // ② 普通行：先按行内编号（1、 2、）切段，再切句归类
    for (const seg of splitInlineEnum(line.text)) {
      const cs = splitClauses(line.text, seg.start, seg.end);
      cs.forEach((c, i) => {
        const raw = c.text;
        const t = raw.trim();
        if (!t) return;
        const start = line.start + c.start;
        const end = line.start + c.end;
        const times = findTimes(t, { now }).map((x) => ({ ...x, index: x.index + start, end: x.end + start }));
        const first = i === 0;

        // 过渡词：行首的直接丢，句中的丢
        if (isConnector(t)) return;

        if (times.length) {
          // a) 续写句：给当前事件补时间（结束时间进 dueEnd，其余进备注）
          if (cur && isContinuation(t)) {
            const t0 = times[0];
            const core = meaningful(t);
            if (t0.start && /(结束|散会|完毕|闭会|截止|下课|散场|离场|完)$/.test(core)) {
              cur.dueEndTime = t0;
            } else {
              cur.noteHints.push(t);
            }
            touch(cur, start, end);
            return;
          }
          // b) 只有时间、没有任务语义，且已有事件 -> 挂到当前事件
          if (cur && !isTaskClause(t) && cur.lineIdx === lineIdx) {
            for (const x of times) cur.times.push(x);
            cur.clauses.push({ text: t, start, end, times });
            touch(cur, start, end);
            return;
          }
          // c) 新事件
          open(lineIdx);
          cur.times.push(...times);
          cur.clauses.push({ text: t, start, end, times });
          touch(cur, start, end);
          return;
        }

        // ③ 没有时间的句子
        if (!cur) {
          // 还没有事件：先存着。像抬头的会被下一个事件吸收，像任务的自成一条
          pending.push({ text: t, start, end, times });
          return;
        }

        const sameLine = cur.lineIdx === lineIdx;
        const noteLead = NOTE_LEAD.test(t) || (first && !sameLine && t.length <= 12 && !isTaskClause(t));

        if (noteLead) {
          cur.clauses.push({ text: t, start, end, times });
          touch(cur, start, end);
          return;
        }
        if (sameLine) {
          cur.clauses.push({ text: t, start, end, times });
          touch(cur, start, end);
          return;
        }
        // 跨行 + 有动作动词 -> 新事件
        if (isTaskClause(t)) {
          open(lineIdx);
          cur.clauses.push({ text: t, start, end, times });
          touch(cur, start, end);
          return;
        }
        cur.clauses.push({ text: t, start, end, times });
        touch(cur, start, end);
      });
    }
  }
  flush();
  if (pending.length) {
    const usable = pending.filter((p) => {
      const s = p.text.trim();
      if (isHeaderClause(s)) return false;
      if (hasAction(s)) return true;
      return s.replace(/[\s，,。、；;：:]/g, '').length >= 4;
    });
    if (usable.length) {
      const ev = newEvent(usable[0].lineIdx || 0);
      for (const p of usable) { ev.clauses.push(p); touch(ev, p.start, p.end); }
      events.push(ev);
    }
    pending = [];
  }
  return events.filter((e) => e.clauses.length || e.forcedTitle || e.place || e.times.length);
}

/* ────────────── 标题 ────────────── */

const LEAD_FILLER = /^(?:(?:请务必|麻烦|请|务必|记得|一定要|需要|还需要|还得|还要|顺便|另外|同时|此外|以及|并|且|然后|接着|最好|尽量|于|在|把|将|我们|你们|各位|大家|同学们|同事们|各部门|有|还|就)\s*)+/;

const MODIFIER_LEAD = /^(?:务必|准时|按时|提前|一定|千万|尽量|最好|请|记得|别忘|不要|切勿|直接|立刻|马上|尽快)/;

function cleanTitle(s) {
  let t = String(s || '');
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  t = t.replace(/@[\w\u4e00-\u9fa5]{1,20}/g, ' ');        // @张三 已经在人物里了
  t = t.replace(/(?<=[\u4e00-\u9fa5，。、；：])[ ]+(?=[\u4e00-\u9fa5，。、；：])/g, '');
  t = t.replace(/^[【\[][^】\]]{0,14}[】\]]\s*/, '');
  t = t.trimStart();
  t = t.replace(LEAD_FILLER, '');
  t = t.trimStart();
  t = t.replace(LEAD_FILLER, '');
  t = t.replace(/^[的了是在，,、;；:：\-–—\s]+/, '');
  t = t.replace(/[，,、;；:：\s]+$/, '');
  t = t.replace(/(?:了|吧|呢|啊|哦|呀|嘛)$/, '');
  return tidy(t);
}

function scoreClause(cl, ctx) {
  const txt = cl.text.trim();
  if (!txt) return -99;
  let s = 0;
  const afterBlank = blankSpans(cl.text, ctx.timesInClause.map((t) => ({ index: t.index - cl.start, end: t.end - cl.start }))).trim();
  const m = afterBlank.replace(/[\s，,、。：:]/g, '');
  if (ctx.timesInClause.length) s += 1;
  if (ctx.hasPrimary) s += 5;
  if (hasAction(txt)) s += 4;
  if (INSTRUCTION.test(txt)) s += 1.5;
  if (MODIFIER_LEAD.test(m)) s -= 2.5;
  if (FILLER_ONLY.test(txt) || CONNECTOR_ONLY.test(txt)) s -= 8;
  // 「明天9点面试」的实义部分只有 2 字，但它才是事件本体，不能因为短就压分
  if (m.length < 4 && !ctx.hasPrimary) s -= 6;
  if (/(通知|公告|须知|安排|提醒|如下|内容|事项|方案|说明)$/.test(txt) && !hasAction(txt)) s -= 4;
  if (m.length >= 4 && m.length <= 34) s += 2;
  s += Math.min(m.length, 30) / 12;
  if (/(会议|开会|参加|提交|缴费|报名|面试|体检|回复|确认|预约|领取|检查|整理|复习|考试|聚餐|付款|报销|材料|单据|报告|周报)/.test(txt)) s += 1.5;
  if (/^(关于|有关|—|【|\[)/.test(txt)) s -= 3.5;
  return s;
}

function makeTitle(ev, ctx) {
  const clauses = ev.clauses.filter((c) => c.text.trim());
  if (ev.forcedTitle) return { title: truncate(cleanTitle(ev.forcedTitle), MAX_TITLE), clause: null, weak: false };
  if (!clauses.length) {
    // 整块都是「键：值」表单，没有正文：用键里的活动名兜底（会议时间/面试时间 -> 会议/面试）
    if (ev.keyHint) return { title: ev.keyHint, clause: null, weak: true };
    return { title: '', clause: null, weak: true };
  }
  const primaryIdx = ctx.primaryIndex;

  const scored = clauses.map((c) => {
    const timesInClause = ev.times.filter((t) => t.index >= c.start && t.index < c.end);
    const hasPrimary = primaryIdx != null && primaryIdx >= c.start && primaryIdx < c.end;
    return { c, score: scoreClause(c, { timesInClause, hasPrimary }), timesInClause };
  }).sort((a, b) => b.score - a.score);

  for (const cand of scored) {
    const { c, timesInClause } = cand;
    const marks = [
      ...timesInClause.map((t) => ({ index: t.index - c.start, end: t.end - c.start })),
      ...ctx.placeSpansInClause(c),
    ];
    const t = cleanTitle(blankSpans(c.text, marks));
    if (t.length >= 2 && !isPlaceOnly(t, ctx.placeText)) {
      return { title: truncate(t, MAX_TITLE), clause: c, weak: !hasAction(t) };
    }
  }
  return { title: '', clause: null, weak: true };
}

/** 「三楼会议室」「地点」这类纯地点/纯属性，不能当标题 */
function isPlaceOnly(title, placeText) {
  const t = title.replace(/[\s，。、]/g, '');
  if (!t) return true;
  if (/^(地点|地址|时间|日期|备注|内容|主题|联系人|电话|议程|注意事项|要求)$/.test(t)) return true;
  if (placeText && (placeText.includes(t) || t === placeText)) return true;
  if (/(会议室|办公室|大厅|教室|楼层|楼|室|厅|馆|中心|酒店|大厦|广场|公园|机场|车站|医院|学校)$/.test(t) && !hasAction(t)) return true;
  return false;
}

/* ────────────── 事件 -> item ────────────── */

function buildItem(ev, text, now) {
  if (ev.end <= ev.start) return null;
  const eventText = text.slice(ev.start, ev.end);

  // 时间锚点：优先「有时间」的那些；无时间的事件为 null
  const anchors = [...ev.times].sort((a, b) => a.index - b.index);
  const primary = anchors.find((a) => a.start) || anchors[0] || null;

  const placeFound = findPlace(eventText, anchors.map((a) => ({ ...a, index: a.index - ev.start, end: a.end - ev.start })));
  const place = ev.place || (placeFound ? placeFound.place : '');
  const placeSpan = [];
  if (ev.place) {
    const at = eventText.indexOf(ev.place);
    if (at >= 0) placeSpan.push({ index: at + ev.start, end: at + ev.start + ev.place.length });
  } else if (placeFound) {
    placeSpan.push({ index: placeFound.index + ev.start, end: placeFound.end + ev.start });
  }

  const titleInfo = makeTitle(ev, {
    primaryIndex: primary ? primary.index : null,
    placeText: place,
    placeSpansInClause: (cl) => placeSpan
      .filter((p) => p.index >= cl.start && p.end <= cl.end)
      .map((p) => ({ index: p.index - cl.start, end: p.end - cl.start })),
  });

  if (!titleInfo.title || titleInfo.title.length < 2) return null;
  // 「王总」「地点」这类 2 字残句不是待办
  if (titleInfo.title.length <= 2 && !hasAction(titleInfo.title) && !titleInfo.title.includes('会')) return null;

  const { people, phones } = findPeople(eventText);
  const priority = findPriority(eventText);
  const category = findCategory(eventText + titleInfo.title);

  // ── 备注
  const noteParts = [];
  for (const cl of ev.clauses) {
    if (titleInfo.clause && cl.start === titleInfo.clause.start) continue;
    const t = cl.text.trim();
    if (!t || t.length < 2) continue;
    if (isConnector(t)) continue;
    if (isAttrKeyText(t)) continue;                                   // 光秃秃的「联系人」「地点」
    if (/[【】]/.test(t) || /^(各位|大家|同事|同学|亲爱的|尊敬的)/.test(t)) continue; // 抬头
    if (people.some((p) => t === p || t === p + '处' || t === '联系' + p)) continue;
    if (ev.place && t.includes(ev.place) && t.length < ev.place.length + 10) continue;
    if (place && t.includes(place) && t.length < place.length + 10) continue;
    if (phones.some((p) => t.includes(p))) continue;
    if (t.length < 6 && !hasAction(t) && !/[:：]/.test(t)) continue;
    noteParts.push(t);
  }
  noteParts.push(...ev.noteHints);
  for (const h of findNoteHints(eventText)) noteParts.push(h);
  if (primary && primary.vague) noteParts.push(`时间表述模糊（${primary.text}），建议补一个具体时间`);
  if (anchors.length > 1) {
    for (const a of anchors.slice(1)) {
      if (a.start && a !== primary) noteParts.push(`另一个时间：${a.text}（${describeWhen(a.start, { now, precision: a.precision })}）`);
    }
  }
  if (phones.length) noteParts.push(`电话：${phones.join(' / ')}`);

  const notes = uniqJoin(noteParts.filter((p) => !isSubOf(p, titleInfo.title) && !isSubOf(p, place)));

  // ── 时间
  let due = null, dueEnd = null, dueText = '', precision = 'none', deadline = false;
  if (primary && primary.start) {
    due = toLocalInput(primary.start);
    dueText = primary.text.trim();
    precision = primary.precision;
    deadline = !!primary.isDeadline;
    if (primary.end2) dueEnd = toLocalInput(primary.end2);
  }
  // 续写里的「X点结束」补成结束时间（裸时刻按主事件的时段推断上下午，日期对齐到主事件那天）
  if (ev.dueEndTime && ev.dueEndTime.start && due) {
    const startD = new Date(due.replace('T', ' '));
    let d = ev.dueEndTime.start;
    if (d.getHours() < 12 && startD.getHours() >= 12) d = new Date(d.getTime() + 12 * 3600 * 1000);
    if (d.getFullYear() !== startD.getFullYear() || d.getMonth() !== startD.getMonth() || d.getDate() !== startD.getDate()) {
      d = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate(), d.getHours(), d.getMinutes());
    }
    if (d.getTime() <= startD.getTime()) d = new Date(d.getTime() + 24 * 3600 * 1000);
    dueEnd = toLocalInput(d);
  } else if (ev.dueEndTime && ev.dueEndTime.start && !due) {
    due = toLocalInput(ev.dueEndTime.start);
    dueText = ev.dueEndTime.text;
    precision = 'minute';
  }

  // ── 置信度
  let conf = 0.34;
  if (due) conf += 0.26;
  if (place) conf += 0.12;
  if (people.length) conf += 0.05;
  if (notes) conf += 0.07;
  if (hasAction(titleInfo.title)) conf += 0.13;
  if (titleInfo.weak) conf -= 0.17;
  if (titleInfo.title.length < 4) conf -= 0.08;
  conf = clamp(conf, 0.15, 0.98);

  // ── 原文出处
  const marks = [];
  if (titleInfo.clause) {
    marks.push({ field: 'title', start: titleInfo.clause.start - ev.start, end: titleInfo.clause.end - ev.start });
  }
  for (const a of anchors) marks.push({ field: 'due', start: a.index - ev.start, end: a.end - ev.start });
  if (placeSpan.length) marks.push({ field: 'place', start: placeSpan[0].index - ev.start, end: placeSpan[0].end - ev.start });

  return {
    title: titleInfo.title,
    due, dueEnd, dueText, precision, deadline,
    place,
    people, phones, notes,
    priority, category,
    confidence: Math.round(conf * 100) / 100,
    weak: !!titleInfo.weak,
    source: { text: eventText.trim(), marks: marks.filter((m) => m.end > m.start) },
  };
}

const ATTR_KEY_TEXT = /^(联系人|地点|地址|时间|日期|备注|内容|主题|负责人|电话|联系方式|议程|注意事项|要求|说明|事项|场地|会议地点)$/;
const isAttrKeyText = (t) => ATTR_KEY_TEXT.test(String(t || '').trim());

function isSubOf(p, title) {
  if (!p || !title) return false;
  const a = String(p).replace(/[\s，,。、；;：:]/g, '');
  const b = String(title).replace(/[\s，,。、；;：:]/g, '');
  if (!a) return true;
  return a === b || (a.length >= 2 && b.includes(a));
}

function uniqJoin(parts) {
  const out = [];
  for (const p of parts) {
    const t = tidy(p);
    if (!t || t.length < 2) continue;
    if (out.some((o) => o === t || o.includes(t) || t.includes(o))) continue;
    out.push(t);
  }
  return out.join('；');
}

/* ────────────── 主流程 ────────────── */

export function extract(rawText, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const text = normalize(rawText || '');
  const events = segment(text, now);

  const items = [];
  for (const ev of events) {
    const item = buildItem(ev, text, now);
    if (item) items.push(item);
  }
  const merged = mergeItems(items);
  merged.sort(sortItems);
  return { items: merged, stats: { events: events.length, count: merged.length } };
}

/** 同一段时间 + 高度相似的标题 -> 合并（长文里常见的重复表述） */
export function mergeItems(items) {
  const out = [];
  for (const it of items) {
    const hit = out.find((o) => {
      if (!it.title || !o.title) return false;
      const sim = similarity(o.title, it.title);
      const sameDue = (o.due || '') === (it.due || '');
      if (sim >= 0.62) return true;
      if (sameDue && sim >= 0.42) return true;
      if (sameDue && (o.title.includes(it.title) || it.title.includes(o.title))) return true;
      return false;
    });
    if (hit) {
      if (it.title.length > hit.title.length) hit.title = it.title;
      if (!hit.place && it.place) hit.place = it.place;
      if (!hit.due && it.due) { hit.due = it.due; hit.dueText = it.dueText; hit.dueEnd = it.dueEnd; hit.precision = it.precision; hit.deadline = it.deadline; }
      if (!hit.dueEnd && it.dueEnd) hit.dueEnd = it.dueEnd;
      hit.people = [...new Set([...hit.people, ...it.people])];
      hit.notes = uniqJoin([hit.notes, it.notes].filter(Boolean));
      hit.confidence = Math.max(hit.confidence, it.confidence);
      hit.source.text = hit.source.text + ' ' + it.source.text;
      hit.source.marks = [...hit.source.marks, ...it.source.marks.map((m) => ({ ...m, start: m.start + hit.source.text.length, end: m.end + hit.source.text.length }))];
      continue;
    }
    out.push({ ...it });
  }
  return out;
}

function sortItems(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return b.confidence - a.confidence;
}
