// src/app.js —— 界面接线：粘贴 → 抽取 → 编辑 → 待办 → 导出
import { extract } from './extract.js';
import { uid, escapeHtml, clamp } from './util.js';
import {
  makeTodo, groupTodos, filterTodos, dueLabel,
  toMarkdown, toICS, toPlainText, CATEGORIES,
} from './model.js';
import { loadState, saveState, loadAI, saveAI, exportBackup } from './store.js';
import { extractWithAI, testAI, PROVIDERS } from './llm.js';

/** 改成你自己的仓库地址即可 */
const REPO_URL = 'https://github.com/embers1117/chousi';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const SAMPLE = `【部门通知】各位同事：下周三下午3点在三楼大会议室召开第二季度工作总结会，请各部门负责人提前准备汇报材料，务必准时参加。

另外，请于本周五上午10点前把本部门上季度的报销单据交到行政部小张处，逾期不再受理。

还有，明天中午12点半公司食堂有团建聚餐，记得带工牌。

最后提醒一下，6月30日前完成年度体检预约，体检地点是市第一人民医院体检中心，联系李医生（电话13800138000）。`;

const state = {
  todos: [],
  drafts: [],
  picked: new Set(),
  prefs: {},
  ai: {},
  tab: 'drafts',
  busy: false,
};

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => saveState(state), 350);
}

/* ───────────────── 主题 ───────────────── */

function resolvedTheme() {
  if (state.prefs.theme === 'light' || state.prefs.theme === 'dark') return state.prefs.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

/* ───────────────── 卡片 ───────────────── */

function findItem(card) {
  const id = card?.dataset.id;
  if (!id) return null;
  const pool = card.dataset.mode === 'draft' ? state.drafts : state.todos;
  return pool.find((x) => x.id === id) || null;
}

function renderSource(item) {
  const src = item && item.source;
  if (!src || !src.text) return '<em class="src-empty">这条是手动添加的，没有原文出处。</em>';
  const marks = (src.marks || []).slice().sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const m of marks) {
    const s = clamp(m.start, pos, src.text.length);
    const e = clamp(m.end, s, src.text.length);
    if (e <= s) continue;
    out += escapeHtml(src.text.slice(pos, s));
    out += `<mark>${escapeHtml(src.text.slice(s, e))}</mark>`;
    pos = e;
  }
  out += escapeHtml(src.text.slice(pos));
  return out;
}

function dueChipText(item) {
  if (item.due) return (item.deadline ? '截止 ' : '') + dueLabel(item);
  if (item.dueText) return '待定 · ' + item.dueText;
  return '没有时间';
}

function fillCard(node, item, mode) {
  node.dataset.mode = mode;
  node.dataset.id = item.id;
  node.classList.toggle('is-done', !!item.done);
  node.classList.toggle('is-picked', state.picked.has(item.id));
  node.classList.remove('priority-high', 'priority-normal', 'priority-low');
  node.classList.add('priority-' + (item.priority || 'normal'));

  const title = $('.card-title', node);
  title.value = item.title || '';
  title.title = item.title || '';

  $('[data-field="dueText"]', node).value = item.dueText || '';
  $('[data-field="due"]', node).value = item.due || '';
  $('[data-field="deadline"]', node).checked = !!item.deadline;
  $('[data-field="place"]', node).value = item.place || '';
  $('[data-field="people"]', node).value = (item.people || []).join('、');
  $('[data-field="notes"]', node).value = item.notes || '';
  $('[data-field="category"]', node).value = item.category || 'other';
  $('[data-field="priority"]', node).value = item.priority || 'normal';

  const conf = $('[data-act="conf"]', node);
  const c = typeof item.confidence === 'number' ? item.confidence : 0.9;
  conf.textContent = Math.round(c * 100) + '%';
  conf.classList.remove('conf-high', 'conf-mid', 'conf-low');
  conf.classList.add(c >= 0.8 ? 'conf-high' : c >= 0.55 ? 'conf-mid' : 'conf-low');

  const chip = $('[data-act="duelabel"]', node);
  chip.textContent = dueChipText(item);
  chip.classList.toggle('badge-warn', !!item.due && new Date(item.due) < new Date() && !item.done);

  const pick = $('[data-act="pick"]', node);
  if (pick) pick.checked = state.picked.has(item.id);

  const done = $('[data-act="done"]', node);
  if (done) done.checked = !!item.done;

  const src = $('.card-source', node);
  src.setAttribute('hidden', '');
  src.innerHTML = '';

  return node;
}

function cardFor(item, mode) {
  const tpl = $('#tpl-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  return fillCard(node, item, mode);
}

function refreshChip(card, item) {
  const chip = $('[data-act="duelabel"]', card);
  if (chip) chip.textContent = dueChipText(item);
}

/* ───────────────── 渲染 ───────────────── */

function renderHeader() {
  $('#count-drafts').textContent = state.drafts.length;
  const open = state.todos.filter((t) => !t.done).length;
  $('#count-todos').textContent = open;
  $('#counter').textContent = `${$('#input').value.length} 字`;
  $('#engine-hint').textContent = state.prefs.engine === 'ai'
    ? (state.ai.key ? 'AI 增强 · 已配置' : 'AI 增强 · 未配置 Key')
    : '规则引擎 · 本地运行';
  $$('#engine-seg .seg-item').forEach((b) => b.classList.toggle('is-on', b.dataset.engine === state.prefs.engine));
  $$('#tabs .tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === state.tab));
  $('#view-drafts').hidden = state.tab !== 'drafts';
  $('#view-todos').hidden = state.tab !== 'todos';
  $('#bulkbar').hidden = state.drafts.length === 0;
  $('#bulk-count').textContent = state.picked.size
    ? `已选 ${state.picked.size} 条`
    : `共 ${state.drafts.length} 条，未选择`;
  $('#btn-add-all').textContent = state.picked.size ? `加入选中的 ${state.picked.size} 条` : '全部加入待办';
  const all = state.drafts.length > 0 && state.picked.size === state.drafts.length;
  $('#chk-all').checked = all;
  $('#lnk-gh').href = REPO_URL;
}

function renderDrafts() {
  const list = $('#list-drafts');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const d of state.drafts) frag.appendChild(cardFor(d, 'draft'));
  list.appendChild(frag);
  $('#empty-drafts').hidden = state.drafts.length > 0;
}

function renderTodos() {
  const list = $('#list-todos');
  list.innerHTML = '';
  const q = $('#search').value;
  const filtered = filterTodos(state.todos, { q, cat: state.prefs.cat, hideDone: state.prefs.hideDone });
  const groups = groupTodos(filtered);
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<span>${escapeHtml(g.title)}</span><span class="count">${g.count}</span>`;
    frag.appendChild(head);
    for (const t of g.items) frag.appendChild(cardFor(t, 'saved'));
  }
  list.appendChild(frag);
  $('#empty-todos').hidden = filtered.length > 0;

  // 分类筛选条
  const chips = $('#filter-cats');
  const counts = {};
  for (const t of state.todos) if (!t.done) counts[t.category] = (counts[t.category] || 0) + 1;
  const cats = [['all', '全部', state.todos.filter((t) => !t.done).length]]
    .concat(Object.entries(CATEGORIES).filter(([k]) => counts[k]).map(([k, label]) => [k, label, counts[k]]));
  chips.innerHTML = cats.map(([k, label, n]) =>
    `<button class="chip${state.prefs.cat === k ? ' is-on' : ''}" data-cat="${k}">${label} ${n}</button>`).join('');
}

function renderAll() {
  renderHeader();
  renderDrafts();
  renderTodos();
}

function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', kind === 'error');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 5200 : 2400);
}

/* ───────────────── 抽取 ───────────────── */

function setBusy(on) {
  state.busy = on;
  const btn = $('#btn-extract');
  btn.disabled = on;
  $('.btn-label', btn).textContent = on ? '抽取中…' : '抽 取';
}

async function runExtract() {
  if (state.busy) return;
  const text = $('#input').value;
  if (!text.trim()) { toast('先粘一段文字进来'); $('#input').focus(); return; }

  setBusy(true);
  try {
    let items;
    if (state.prefs.engine === 'ai') {
      try {
        items = await extractWithAI(text, state.ai);
      } catch (err) {
        toast('AI 抽取失败，已用规则引擎兜底：' + String(err.message || err).split('\n')[0], 'error');
        items = extract(text).items;
      }
    } else {
      items = extract(text).items;
    }

    if (!items.length) {
      toast('没抽出待办，试试补上「时间 + 要做什么」');
      return;
    }
    state.drafts = items.map((it) => ({ ...it, id: uid('dr') }));
    state.picked = new Set();
    state.tab = 'drafts';
    renderAll();
    toast(`抽出 ${items.length} 条待办`);
  } catch (err) {
    console.error(err);
    toast('抽取出错：' + (err.message || err), 'error');
  } finally {
    setBusy(false);
    persist();
  }
}

/* ───────────────── 待办操作 ───────────────── */

function addDrafts(list) {
  if (!list.length) return;
  for (const d of list) {
    state.todos.unshift(makeTodo({ ...d, done: false, createdAt: new Date().toISOString() }));
  }
  const ids = new Set(list.map((d) => d.id));
  state.drafts = state.drafts.filter((d) => !ids.has(d.id));
  for (const id of ids) state.picked.delete(id);
  renderAll();
  persist();
  toast(`已加入 ${list.length} 条待办`);
}

function addAll() {
  const list = state.picked.size ? state.drafts.filter((d) => state.picked.has(d.id)) : state.drafts.slice();
  addDrafts(list);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ───────────────── 事件 ───────────────── */

function onFieldInput(e) {
  const el = e.target;
  const field = el.dataset.field;
  if (!field) return;
  const card = el.closest('.card');
  const item = findItem(card);
  if (!item) return;

  if (field === 'people') item.people = el.value.split(/[,，、;；\s]+/).filter(Boolean);
  else if (field === 'notes') item.notes = el.value;
  else item[field] = el.value;

  if (field === 'title') {
    el.title = el.value;
    card.classList.toggle('is-done', !!item.done);
  }
  if (field === 'dueText' || field === 'due') refreshChip(card, item);
  item.updatedAt = new Date().toISOString();
  persist();
}

function onFieldChange(e) {
  const el = e.target;
  const field = el.dataset.field;
  const card = el.closest('.card');
  const item = card ? findItem(card) : null;

  if (field && item) {
    if (field === 'due') {
      item.due = el.value || null;
      if (item.due) {
        const hasTime = !/T00:00$/.test(item.due);
        item.precision = hasTime ? 'minute' : 'day';
      } else {
        item.precision = 'none';
      }
      refreshChip(card, item);
      if (card.dataset.mode === 'saved') renderTodos();
    } else if (field === 'deadline') {
      item.deadline = el.checked;
      refreshChip(card, item);
    } else if (field === 'priority' || field === 'category') {
      item[field] = el.value;
      if (field === 'priority') {
        card.classList.remove('priority-high', 'priority-normal', 'priority-low');
        card.classList.add('priority-' + item.priority);
      }
      if (card.dataset.mode === 'saved') renderTodos();
    } else if (field === 'people') {
      item.people = el.value.split(/[,，、;；\s]+/).filter(Boolean);
    }
    item.updatedAt = new Date().toISOString();
    persist();
    return;
  }

  const act = el.dataset.act;
  if (!act) return;
  const it = card ? findItem(card) : null;
  if (!it) return;

  if (act === 'pick') {
    if (el.checked) state.picked.add(it.id); else state.picked.delete(it.id);
    card.classList.toggle('is-picked', el.checked);
    renderHeader();
  } else if (act === 'done') {
    it.done = el.checked;
    card.classList.toggle('is-done', it.done);
    setTimeout(renderTodos, 120);
    persist();
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const act = btn.dataset.act;
    const card = btn.closest('.card');
    const item = card ? findItem(card) : null;

    if (act === 'save' && item) { addDrafts([item]); return; }
    if (act === 'del' && item) {
      if (card.dataset.mode === 'draft') {
        state.drafts = state.drafts.filter((d) => d.id !== item.id);
        state.picked.delete(item.id);
      } else {
        state.todos = state.todos.filter((t) => t.id !== item.id);
      }
      renderAll();
      persist();
      toast('已删除');
      return;
    }
    if (act === 'source' && card) {
      const box = $('.card-source', card);
      if (box.hidden) {
        box.innerHTML = renderSource(item);
        box.removeAttribute('hidden');
      } else {
        box.setAttribute('hidden', '');
      }
      return;
    }
    if (act === 'conf') {
      toast('置信度：抽取时各字段把握的综合值，可手动修改内容');
      return;
    }
    if (act === 'duelabel') {
      const inp = card && $('[data-field="due"]', card);
      if (inp) { inp.showPicker ? inp.showPicker() : inp.focus(); }
      return;
    }
  }

  const cat = e.target.closest('[data-cat]');
  if (cat) {
    state.prefs.cat = cat.dataset.cat;
    renderTodos();
    persist();
    return;
  }

  const tab = e.target.closest('.tab');
  if (tab) {
    state.tab = tab.dataset.tab;
    renderHeader();
    return;
  }

  const eng = e.target.closest('#engine-seg .seg-item');
  if (eng) {
    selectEngine(eng.dataset.engine);
    return;
  }

  const exp = e.target.closest('[data-export]');
  if (exp) {
    doExport(exp.dataset.export);
    return;
  }
}

function selectEngine(engine) {
  if (engine === 'ai' && !state.ai.key) {
    openAIDialog();
    return;
  }
  state.prefs.engine = engine;
  renderHeader();
  persist();
}

function doExport(kind) {
  const todos = state.todos;
  if (!todos.length) { toast('还没有待办可以导出'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'md') download(`抽丝待办-${stamp}.md`, toMarkdown(todos), 'text/markdown;charset=utf-8');
  else if (kind === 'ics') download(`抽丝待办-${stamp}.ics`, toICS(todos), 'text/calendar;charset=utf-8');
  else if (kind === 'txt') download(`抽丝待办-${stamp}.txt`, toPlainText(todos), 'text/plain;charset=utf-8');
  else if (kind === 'json') download(`抽丝待办-${stamp}.json`, exportBackup(state), 'application/json;charset=utf-8');
  else if (kind === 'import') { /* reserved */ }
  const dlg = $('#dlg-export');
  if (dlg.open) dlg.close();
  toast('已导出');
}

/* ───────────────── AI 配置 ───────────────── */

function fillAIDialog() {
  const { provider, base, model, key, remember } = state.ai;
  $('#ai-provider').value = provider || 'deepseek';
  const p = PROVIDERS[provider] || PROVIDERS.deepseek;
  $('#ai-base').value = base || p.base;
  $('#ai-model').value = model || p.model;
  $('#ai-key').value = key || '';
  $('#ai-remember').checked = !!remember;
  $('#ai-warn').hidden = true;
}

function openAIDialog() {
  fillAIDialog();
  const dlg = $('#dlg-ai');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function readAIDialog() {
  return {
    provider: $('#ai-provider').value,
    base: $('#ai-base').value.trim(),
    model: $('#ai-model').value.trim(),
    key: $('#ai-key').value.trim(),
    remember: $('#ai-remember').checked,
  };
}

function warnAI(msg, ok) {
  const el = $('#ai-warn');
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('is-ok', !!ok);
}

async function testAIConnection() {
  const cfg = readAIDialog();
  warnAI('正在测试…', true);
  try {
    const first = await testAI(cfg);
    warnAI(`连通成功 ✅ 抽到「${first.title}」`, true);
  } catch (err) {
    warnAI('测试失败：' + String(err.message || err).split('\n')[0]);
  }
}

/* ───────────────── 绑定 ───────────────── */

function bind() {
  $('#input').addEventListener('input', () => {
    $('#counter').textContent = `${$('#input').value.length} 字`;
    state.prefs.lastInput = $('#input').value;
    persist();
  });
  $('#input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === '\n')) {
      e.preventDefault();
      runExtract();
    }
  });

  $('#btn-extract').addEventListener('click', runExtract);
  $('#btn-sample').addEventListener('click', () => {
    $('#input').value = SAMPLE;
    $('#counter').textContent = `${SAMPLE.length} 字`;
    state.prefs.lastInput = SAMPLE;
    persist();
    $('#input').focus();
  });
  $('#btn-clear').addEventListener('click', () => {
    $('#input').value = '';
    $('#counter').textContent = '0 字';
    state.prefs.lastInput = '';
    persist();
    $('#input').focus();
  });

  $('#btn-add-all').addEventListener('click', addAll);
  $('#chk-all').addEventListener('change', (e) => {
    state.picked = e.target.checked ? new Set(state.drafts.map((d) => d.id)) : new Set();
    renderDrafts();
    renderHeader();
  });
  $('#btn-copy-json').addEventListener('click', async () => {
    const ok = await copyText(JSON.stringify(state.drafts.map(({ source, ...rest }) => rest), null, 2));
    toast(ok ? '已复制 JSON' : '复制失败，请手动选择', ok ? undefined : 'error');
  });

  $('#search').addEventListener('input', () => {
    clearTimeout($('#search')._t);
    $('#search')._t = setTimeout(renderTodos, 120);
  });
  $('#btn-clear-done').addEventListener('click', () => {
    const n = state.todos.filter((t) => t.done).length;
    if (!n) { toast('没有已完成的任务'); return; }
    state.todos = state.todos.filter((t) => !t.done);
    renderAll();
    persist();
    toast(`已清理 ${n} 条`);
  });

  $('#btn-theme').addEventListener('click', () => {
    const cur = resolvedTheme();
    state.prefs.theme = cur === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  });
  $('#btn-export').addEventListener('click', () => {
    const dlg = $('#dlg-export');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  });

  $('#btn-ai').addEventListener('click', openAIDialog);
  $('#ai-provider').addEventListener('change', (e) => {
    const p = PROVIDERS[e.target.value];
    if (p && p.base) {
      $('#ai-base').value = p.base;
      $('#ai-model').value = p.model;
    }
  });
  $('#btn-ai-test').addEventListener('click', (e) => { e.preventDefault(); testAIConnection(); });
  $('#btn-ai-save').addEventListener('click', (e) => {
    e.preventDefault();
    state.ai = readAIDialog();
    saveAI(state.ai);
    if (state.ai.key) state.prefs.engine = 'ai';
    $('#dlg-ai').close();
    renderHeader();
    persist();
    toast(state.ai.key ? '已保存，抽取引擎切到 AI' : '已清空 AI 配置');
  });
  $('#dlg-ai').addEventListener('close', () => {
    if (!state.ai.key) $('#dlg-ai').querySelector('form').reset();
    fillAIDialog();
  });

  document.addEventListener('click', onClick);
  document.addEventListener('input', onFieldInput);
  document.addEventListener('change', onFieldChange);

  // 拖一个 .txt/.md 文件进来直接填充
  const ta = $('#input');
  ['dragover', 'drop'].forEach((ev) => {
    ta.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev !== 'drop') return;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        ta.value = String(reader.result || '');
        $('#counter').textContent = `${ta.value.length} 字`;
        toast('已读入文件，点「抽取」');
      };
      reader.readAsText(f, 'utf-8');
    });
  });

  window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => { if (state.prefs.theme === 'system') applyTheme(); });
}

/* ───────────────── 启动 ───────────────── */

function init() {
  const saved = loadState();
  state.todos = saved.todos;
  state.prefs = saved.prefs;
  state.ai = loadAI();
  applyTheme();

  if (state.prefs.lastInput) {
    $('#input').value = state.prefs.lastInput;
    $('#counter').textContent = `${state.prefs.lastInput.length} 字`;
  }
  bind();
  renderAll();

  if (!state.todos.length && !state.drafts.length) {
    setTimeout(() => toast('点「载入示例」试试'), 600);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// 便于调试 & 测试
window.__chousi = { state, runExtract, addAll, extract };
