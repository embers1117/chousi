# chousi · 抽丝

> Paste a wall of text → get structured to-dos.

[![ci](https://github.com/embers1117/chousi/actions/workflows/ci.yml/badge.svg)](https://github.com/embers1117/chousi/actions/workflows/ci.yml)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**[中文说明](README.md)** · [MIT](LICENSE)

`chousi` is a tiny, dependency-free web tool for the one thing every to-do app gets wrong:
**turning a long message into an actionable task.**

Paste a notice, a group-chat backlog, an email thread or meeting notes. It extracts
**when / where / who / what / notes / priority** and gives you editable task cards.

- 🫙 **Pure front-end, zero dependencies, works offline** — one HTML file, double-click to run.
- 🧠 **Rule engine first** — Chinese date/location/person parsing built in, no API key needed.
- ✨ **Optional LLM boost** — bring your own OpenAI-compatible key; falls back to rules on failure.
- 🔎 **Every task is traceable** — expand a card to see the source sentence with the evidence highlighted.
- 📤 **Export** — Markdown, `.ics` calendar, JSON, plain text.

![chousi: paste a notice on the left, get four editable task cards on the right](docs/screenshot.png)

## Quick start

```bash
# 1) just open the prebuilt single file
start dist/chousi.html          # macOS: open, Linux: xdg-open

# 2) or serve the source (native ES modules, no build step)
npm run dev                     # http://127.0.0.1:5173
```

No `npm install` — there are no dependencies at all. Node 18+ is only needed for the dev server and tests.

## What it understands

| Input (Chinese) | Parsed (assuming today is Wed 2025-05-07) |
|---|---|
| 明天上午9点 / 后天下午3点半 | 5/8 09:00 / 5/9 15:30 |
| 下周三下午3点 | 5/14 15:00 |
| 周五 / 周一 | this Fri 5/9 / next Mon 5/12 (rolls forward if passed) |
| 本周五上午10点**前** | 5/9 10:00, flagged as a **deadline** |
| 6月30日 / 2025-05-09 | absolute dates |
| 月底 / 今年年底 / 下个月15号 | 5/31 / 12/31 / 6/15 |
| 三天内 / 两个小时后 | relative to now |
| 9:00-11:00 / 晚上7点半到9点 | time **ranges** (start + end) |

Also: locations (`在三楼大会议室`, `地点：…`, 腾讯会议 + meeting ID), people (`张老师`, `行政部小张`,
`@nick`, phone numbers), notes (`携带 / 记得 / 逾期 …`), priority (重要/紧急 vs 有空/不急) and a category.

Chinese is the primary target; English coverage is intentionally minimal for now.

## Development

```bash
npm test        # 80 unit tests (no install needed)
npm run build   # regenerate dist/chousi.html (single file, file:// friendly)
npm run dev     # local preview
npm run proxy   # optional local CORS proxy for the LLM mode
```

The test suite covers the temporal parser (34 table-driven cases pinned to a fixed "now"),
a **segmentation regression suite** (15 cases: "one event split into three", "a location line
turned into a todo", "a note turned into a todo"), the extraction pipeline against realistic
notices, and a **contract test** that every `id` / `data-field` / `data-act` used by `app.js`
actually exists in `index.html`.

## Privacy

Everything lives in your browser's `localStorage`. No backend, no account, no analytics.
In rules mode nothing leaves your machine at all — LLM mode talks only to the endpoint you configure.

## Layout

```
index.html          single page shell + card template
src/app.js          UI wiring (events, rendering, export)
src/extract.js      pipeline: split → event units → fields → dedupe
src/time.js         Chinese temporal parser (the heart)
src/fields.js       place / person / priority / category rules
src/model.js        pure data layer: grouping, filtering, md + ics export
src/store.js        localStorage
src/llm.js          optional OpenAI-compatible adapter
tests/              node:test suites
tools/              dev server, bundler, CORS proxy, test runner
```

## Roadmap

- [ ] Mobile layout + PWA
- [ ] Cross-device sync (WebDAV / minimal self-hosted backend)
- [ ] Lunar calendar & festivals (国庆, 中秋, 春节)
- [ ] Recurring tasks (every Friday, 15th of each month)
- [ ] Browser extension: right-click selected text → to-do
- [ ] English / Japanese rule packs

## License

[MIT](LICENSE)
