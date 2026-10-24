// src/store.js —— 本地持久化（localStorage），全部带 try/catch，坏数据不会让应用白屏

import { makeTodo } from './model.js';

const K_STATE = 'chousi.state.v1';
const K_AI = 'chousi.ai.v1';

export const DEFAULT_PREFS = {
  theme: 'system',      // system | light | dark
  engine: 'rules',      // rules | ai
  hideDone: false,
  cat: 'all',
  lastInput: '',
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadState() {
  const raw = readJSON(K_STATE, {});
  const todos = Array.isArray(raw.todos) ? raw.todos.filter((t) => t && t.title).map((t) => makeTodo(t)) : [];
  const prefs = { ...DEFAULT_PREFS, ...(raw.prefs || {}) };
  return { todos, prefs };
}

export function saveState(state) {
  return writeJSON(K_STATE, {
    v: 1,
    todos: state.todos || [],
    prefs: state.prefs || DEFAULT_PREFS,
    savedAt: new Date().toISOString(),
  });
}

export function clearState() {
  try { localStorage.removeItem(K_STATE); } catch { /* ignore */ }
}

/* ── AI 配置 ── */

export function loadAI() {
  const raw = readJSON(K_AI, {});
  return {
    provider: raw.provider || 'deepseek',
    base: raw.base || '',
    model: raw.model || '',
    key: raw.key || '',
    remember: !!raw.key,
  };
}

export function saveAI(cfg) {
  if (cfg.remember && cfg.key) {
    writeJSON(K_AI, { provider: cfg.provider, base: cfg.base, model: cfg.model, key: cfg.key });
  } else {
    try { localStorage.removeItem(K_AI); } catch { /* ignore */ }
  }
}

export function exportBackup(state) {
  return JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), todos: state.todos, prefs: state.prefs }, null, 2);
}

export function importBackup(json) {
  const v = typeof json === 'string' ? JSON.parse(json) : json;
  const todos = Array.isArray(v.todos) ? v.todos.filter((t) => t && t.title).map((t) => makeTodo(t)) : [];
  return { todos };
}
