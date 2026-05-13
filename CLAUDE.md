# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Yuketang Helper Auto (雨课堂助手) is a Tampermonkey userscript that augments the Yuketang (雨课堂) online classroom platform. It intercepts the platform's WebSocket/XHR traffic to detect slides and problems in real time, then provides AI-powered answering, OCR, translation, and courseware browsing. Runs on Chrome/Edge via Tampermonkey.

## Build & Development

All commands run from the `ykt-helper/` directory:

```bash
cd ykt-helper
npm i                # install dependencies
npm run build        # bundle to dist/ykt-helper-<ver>.user.js
npm run dev          # watch mode (rebuild on file change)
```

Rollup bundles `src/index.js` into a single IIFE userscript with the Tampermonkey header from `userscript.meta.js`. There are no tests or linting configured.

To test: copy the built file from `dist/` into Tampermonkey, then open a Yuketang classroom page.

## Version Management

When releasing, update **three** places:
1. `userscript.meta.js` — the `@version` field in the userscript header
2. `rollup.config.mjs` — the `OUT_FILE` constant (e.g. `dist/ykt-helper-1211.user.js`)
3. Copy the built output into `release/` with the matching version filename

## Architecture

```
ykt-helper/src/
├── index.js              — Entry point: injects styles, mounts UI, installs interceptors
├── core/
│   ├── env.js            — GM_* API wrappers, dynamic script loaders (html2canvas, jsPDF)
│   ├── storage.js        — localStorage wrapper with JSON serialization and Map support
│   ├── types.js          — Problem type enum (1-5) and DEFAULT_CONFIG
│   └── vuex-helper.js    — Reaches into Yuketang's Vue app to read Vuex store state
├── net/
│   ├── ws-interceptor.js — Subclasses WebSocket to intercept classroom events
│   ├── xhr-interceptor.js— Subclasses XMLHttpRequest to capture API responses
│   └── fetch-interceptor.js — Patches window.fetch for additional interception
├── state/
│   ├── repo.js           — Central data store (Maps for presentations, slides, problems)
│   └── actions.js        — Event handlers: problem unlock → AI query → auto-submit pipeline
├── ai/
│   ├── kimi.js           — Primary AI adapter (OpenAI-compatible API, vision+text)
│   ├── openai.js         — OpenAI adapter
│   ├── deepseek.js       — DeepSeek adapter
│   ├── gemini.js         — Gemini adapter
│   └── openrouter.js     — OpenRouter adapter
├── tsm/
│   ├── ai-format.js      — Builds prompts per problem type, parses AI responses
│   └── answer.js         — Submits answers to Yuketang's API
├── capture/
│   └── screenshoot.js    — Captures problem screenshots for vision models
└── ui/
    ├── toolbar.js        — Bottom-left floating toolbar (6 buttons)
    ├── ui-api.js         — Central UI controller, config management, panel orchestration
    ├── toast.js          — Notification toasts
    ├── styles.css/js     — Injected CSS styles
    └── panels/           — Each panel is an .html template + .js logic pair
        ├── settings.*    — API key and auto-answer configuration
        ├── ai.*          — AI interaction panel
        ├── presentation.*— Courseware/slide browser with PDF export
        ├── problem-list.*— Problem history
        ├── active-problems.* — Currently active problems
        ├── tutorial.*    — Usage tutorial
        └── auto-answer-popup.js — Post-answer result popup
```

### Data Flow

1. **Interception** (`net/`): WebSocket and XHR subclasses detect classroom data (presentations, slides, problem unlocks) from Yuketang's API traffic
2. **State** (`state/repo.js`): Parsed data is stored in `repo` Maps keyed by ID
3. **Actions** (`state/actions.js`): On problem unlock, triggers the AI pipeline — format prompt → call AI → parse answer → submit
4. **AI** (`ai/` + `tsm/ai-format.js`): All AI adapters use OpenAI-compatible chat completion format. `ai-format.js` generates type-specific prompts and parses responses
5. **UI** (`ui/`): Panels read from `repo` and `ui.config`; toolbar buttons toggle panel visibility

### Key Patterns

- **UI panels** use paired `.html` (template string) + `.js` (logic) files, imported via rollup's string plugin. No framework — plain DOM manipulation.
- **AI adapters** all follow the same signature pattern and use `GM_xmlhttpRequest` to bypass CORS.
- **Config** is persisted to `localStorage` via `StorageManager` with prefix `ykt-helper:`.
- The script hooks into Yuketang's internal Vue/Vuex store (`vuex-helper.js`) to read current slide state — this is fragile and version-dependent.

## Supported Yuketang Environments

The script matches multiple Yuketang domains: `pro.yuketang.cn`, `changjiang.yuketang.cn`, `www.yuketang.cn`. Environment detection happens in both WS and XHR interceptors.
