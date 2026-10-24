// src/extract.js —— 抽取流水线
//
//   原文 → 归一化 → 切行 → 切句 → 认「事件单元」→ 逐字段抽取 → 合并去重 → 置信度
//
// 一条 item:
//   { title, due, dueText, dueEnd, precision, deadline, place, people, phones,
//     notes, priority, category, confidence, weak, source:{text,marks} }
//   due 形如 '2025-05-09T10:00'（本地墙钟时间，直接喂 datetime-local）

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

/* ────────────── 事件单元 ────────────── */

function buildUnits(block, times) {
  const clauses = splitClauses(block.text, 0, block.text.length);
  const units = [];
  let pending = null;

  for (const cl of clauses) {
    // 时间锚点：起点落在这句里
    const anchors = times.filter((t) => t.index >= cl.start && t.index < cl.end);
    if (anchors.length) {
      const unit = { clauses: [], anchors: [], start: cl.start, end: cl.end };
      if (pending) {
        // 前面那句没有时间（多半是「关于××的通知」或主语），并进来当上下文
        unit.clauses = pending.clauses;
        unit.start = pending.start;
        pending = null;
      }
      unit.clauses.push(cl);
      unit.anchors.push(...anchors);
      unit.end = cl.end;
      units.push(unit);
    } else if (units.length && !pending) {
      // 没有时间锚点、也没有新单元在等 -> 归到上一个单元（「记得带上…」）
      const last = units[units.length - 1];
      last.clauses.push(cl);
      last.end = cl.end;
    } else {
      if (!pending) pending = { clauses: [], anchors: [], start: cl.start, end: cl.end };
      pending.clauses.push(cl);
      pending.end = cl.end;
    }
  }
  if (pending) units.push(pending);
  return units;
}

/* ────────────── 标题 ────────────── */

const LEAD_FILLER = /^(?:(?:请务必|麻烦|请|务必|记得|一定要|需要|还需要|还得|还要|顺便|另外|同时|此外|以及|并|且|然后|接着|最好|尽量|于|在|把|将|我们|你们|各位|大家|同学们|同事们|各部门|有|还|就)\s*)+/;

function cleanTitle(s) {
  let t = String(s || '');
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  // 中文之间的空白直接吃掉（时间/地点被抹掉后留下的空洞）
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

const MODIFIER_LEAD = /^(?:务必|准时|按时|提前|一定|千万|尽量|最好|请|记得|别忘|不要|切勿|直接|立刻|马上|尽快)/;
const FILLER_ONLY = /^(?:最后|另外|还有|此外|同时|以及|然后|接下来|补充一下|最后提醒一下|特此通知|请知悉|谢谢|收到|好的|嗯+|ok)[\s:：吧了。！!]*$/i;

function scoreClause(cl, ctx) {
  const txt = cl.text.trim();
  if (!txt) return -99;
  let s = 0;
  const afterBlank = blankSpans(cl.text, ctx.timesInClause.map((t) => ({ index: t.index - cl.start, end: t.end - cl.start }))).trim();
  const meaningful = afterBlank.replace(/[\s，,、。：:]/g, '');
  if (ctx.timesInClause.length) s += 1;
  if (ctx.hasPrimary) s += 5;                       // 主时间所在的那句通常是事件本体
  if (hasAction(txt)) s += 4;
  if (/(请|需要|务必|要|记得|别忘了|麻烦)/.test(txt)) s += 1.5;
  if (MODIFIER_LEAD.test(meaningful)) s -= 2.5;     // 「务必准时参加」是修饰语，不是主体
  if (FILLER_ONLY.test(txt)) s -= 8;
  if (meaningful.length < 4) s -= 6;
  if (/(通知|公告|须知|安排|提醒|如下|内容|事项|方案|说明)$/.test(txt) && !hasAction(txt)) s -= 4;
  if (meaningful.length >= 4 && meaningful.length <= 34) s += 2;
  s += Math.min(meaningful.length, 30) / 12;        // 同等条件下，信息量大的句子优先
  if (/(会议|开会|参加|提交|缴费|报名|面试|体检|回复|确认|预约|领取|检查|整理|复习|考试|聚餐|付款|报销|材料|单据|报告|周报)/.test(txt)) s += 1.5;
  if (/^(关于|有关|—|【|\[)/.test(txt)) s -= 3.5;
  return s;
}

function makeTitle(unit, ctx) {
  const clauses = unit.clauses.filter((c) => c.text.trim());
  if (!clauses.length) return { title: '', clause: null, weak: true };
  const primaryIdx = ctx.primaryIndex;

  const scored = clauses.map((c) => {
    const timesInClause = unit.anchors.filter((t) => t.index >= c.start && t.index < c.end);
    const hasPrimary = primaryIdx != null && primaryIdx >= c.start && primaryIdx < c.end;
    return { c, score: scoreClause(c, { timesInClause, hasPrimary }), timesInClause };
  }).sort((a, b) => b.score - a.score);

  for (const cand of scored) {
    const { c, timesInClause } = cand;
    const marks = [
      ...timesInClause.map((t) => ({ index: t.index - c.start, end: t.end - c.start })),
      ...ctx.placeSpansInClause(c),
    ];
    let t = blankSpans(c.text, marks);
    t = cleanTitle(t);
    if (t.length >= 2) return { title: truncate(t, MAX_TITLE), clause: c, weak: !hasAction(t) };
  }
  const first = clauses[0];
  return { title: truncate(cleanTitle(first.text) || tidy(first.text), MAX_TITLE), clause: first, weak: true };
}

/* ────────────── 主流程 ────────────── */

export function extract(rawText, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const text = normalize(rawText || '');
  const items = [];

  for (const rawBlock of splitBlocks(text)) {
    const block = stripListMarker(rawBlock);
    if (!block.text.trim()) continue;
    // 纯符号行跳过
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(block.text)) continue;

    const times = findTimes(block.text, { now });
    const units = buildUnits(block, times);

    for (const unit of units) {
      const item = buildItem(block, unit, { now });
      if (item) items.push(item);
    }
  }

  const merged = mergeItems(items);
  merged.sort(sortItems);
  return { items: merged, stats: { blocks: splitBlocks(text).length, count: merged.length } };
}

function buildItem(block, unit, ctx) {
  const { now } = ctx;
  const unitText = block.text.slice(unit.start, unit.end);
  if (!unitText.trim()) return null;

  const anchors = [...unit.anchors].sort((a, b) => a.index - b.index);
  const primary = anchors.find((a) => a.start) || anchors[0] || null;
  const place = findPlace(unitText, anchors.map((a) => ({ ...a, index: a.index - unit.start, end: a.end - unit.start })));
  const placeSpan = place ? [{ index: place.index + unit.start, end: place.end + unit.start }] : [];

  const titleInfo = makeTitle(unit, {
    primaryIndex: primary ? primary.index : null,
    placeSpansInClause: (cl) => placeSpan
      .filter((p) => p.index >= cl.start && p.end <= cl.end)
      .map((p) => ({ index: p.index - cl.start, end: p.end - cl.start })),
  });

  if (!titleInfo.title || titleInfo.title.length < 2) return null;

  const { people, phones } = findPeople(unitText);
  const priority = findPriority(unitText);
  const category = findCategory(unitText + titleInfo.title);

  // ── 备注：非标题句 + 线索 + 额外时间
  const noteParts = [];
  const placeStr = place ? place.place : '';
  for (const cl of unit.clauses) {
    if (titleInfo.clause && cl.start === titleInfo.clause.start) continue;
    const t = cl.text.trim();
    if (!t || t.length < 2) continue;
    if (FILLER_ONLY.test(t)) continue;
    if (t.length < 14 && /(各位|通知|公告|须知|大家好|特此|敬上)/.test(t)) continue; // 抬头/落款
    if (placeStr && t.includes(placeStr) && t.length < placeStr.length + 8) continue;   // 只是地点
    if (phones.some((p) => t.includes(p))) continue;                                    // 电话单独放
    if (t.length < 6 && !hasAction(t) && !/[:：]/.test(t)) continue;
    noteParts.push(t);
  }
  for (const h of findNoteHints(unitText)) noteParts.push(h);
  if (primary && primary.vague) noteParts.push(`时间表述模糊（${primary.text}），建议补一个具体时间`);
  if (anchors.length > 1) {
    for (const a of anchors.slice(1)) {
      if (a.start) noteParts.push(`另一个时间：${a.text}（${describeWhen(a.start, { now, precision: a.precision })}）`);
    }
  }
  if (phones.length) noteParts.push(`电话：${phones.join(' / ')}`);

  const notes = uniqJoin(noteParts.filter((p) => !isSubOf(p, titleInfo.title)));

  // ── 时间
  let due = null, dueEnd = null, dueText = '', precision = 'none', deadline = false;
  if (primary && primary.start) {
    due = toLocalInput(primary.start);
    dueEnd = primary.end2 ? toLocalInput(primary.end2) : null;
    dueText = primary.text.trim();
    precision = primary.precision;
    deadline = !!primary.isDeadline;
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

  // ── 原文出处 + 高亮标记
  const marks = [];
  if (titleInfo.clause) {
    marks.push({ field: 'title', start: titleInfo.clause.start - unit.start, end: titleInfo.clause.end - unit.start });
  }
  for (const a of anchors) {
    marks.push({ field: 'due', start: a.index - unit.start, end: a.end - unit.start });
  }
  if (place) {
    marks.push({ field: 'place', start: place.index, end: place.end });
  }

  return {
    title: titleInfo.title,
    due, dueEnd, dueText, precision, deadline,
    place: place ? place.place : '',
    people, phones, notes,
    priority, category,
    confidence: Math.round(conf * 100) / 100,
    weak: !!titleInfo.weak,
    source: { text: unitText.trim(), marks: marks.filter((m) => m.end > m.start) },
  };
}

/** p 是否只是标题的碎片（避免备注里重复标题内容） */
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
