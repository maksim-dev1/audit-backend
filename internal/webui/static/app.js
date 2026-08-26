// Audit Log Viewer — вьювер поверх GET /audit/technicians, /audit/logs и т.п.
// Портирован из макета "Audit Log Prototype v3.dc.html" (см. support.js/log-data-v2.js
// в исходном dc-проекте) на чистый JS (без dc-runtime): полный ре-рендер по
// состоянию, без виртуального DOM. Данные тянутся с бэкенда постранично (см.
// internal/httpapi/viewer.go) — в отличие от макета (весь сеанс в памяти),
// плотность на таймлайне и клик-переход по ней считаются по уже загруженной
// странице, а не по всей сессии целиком.
'use strict';

const ACTION_CATEGORIES = new Set(['tap', 'swipe', 'screenView']);
const SEVERITY_COLOR = {
  warning: 'oklch(0.82 0.15 80)',
  error: 'oklch(0.68 0.19 25)',
};

// Группировка категорий по «роду» — только для выпадающего меню категорий
// (см. KIND_META). Список неполный: неизвестные категории попадают в «Прочее».
const KIND_META = {
  action: { ru: 'Действия', hue: 250, chroma: 0.14 },
  network: { ru: 'Сеть', hue: 160, chroma: 0.13 },
  state: { ru: 'Состояние', hue: 300, chroma: 0.14 },
  system: { ru: 'Система', hue: 25, chroma: 0.15 },
  other: { ru: 'Прочее', hue: 70, chroma: 0.1 },
};
function kindOf(category) {
  if (ACTION_CATEGORIES.has(category)) return 'action';
  if (category === 'http') return 'network';
  if (category === 'blocEvent') return 'state';
  if (category === 'memoryWarning' || category === 'appLifecycle') return 'system';
  return 'other';
}

function categoryColor(category, alpha = 1) {
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `oklch(0.75 0.13 ${hue} / ${alpha})`;
}

function fmtHms(iso) { return new Date(iso).toISOString().slice(11, 19); }
function fmtMs(iso) { return new Date(iso).toISOString().slice(19, 23); }
function fmtMinute(iso) { return new Date(iso).toISOString().slice(11, 16); }
function fmtFullTime(iso) { return new Date(iso).toISOString().replace('T', ' ').slice(0, 23) + ' UTC'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function isBinary(v) {
  return typeof v === 'string' && /^<binary \d+ bytes>$/.test(v);
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function metaFor(category, p) {
  p = p || {};
  switch (category) {
    case 'tap': return `${p.route || ''} · ${p.identifier || p.label || '—'} · ${Math.round(p.x || 0)},${Math.round(p.y || 0)}${p.enabled === false ? ' · disabled' : ''}`;
    case 'swipe': return `${p.route || ''} · ${p.direction || ''} ${p.distancePx || ''}px · ${p.durationMs || ''}ms`;
    case 'screenView': return `${p.action || ''} → ${p.route || ''}`;
    case 'http': return `${p.method || ''} ${p.path || ''} · ${p.statusCode || ''} · ${p.durationMs || ''}ms`;
    case 'blocEvent': return `${p.bloc || ''} · ${p.event || ''}`;
    default:
      if (p.exception) return String(p.exception).slice(0, 90);
      if (p.type) return p.type;
      return Object.keys(p).slice(0, 3).map((k) => `${k}=${typeof p[k] === 'object' ? '{…}' : p[k]}`).join(' · ');
  }
}

function hintFor(row, p) {
  p = p || {};
  const code = p.statusCode;
  if (code === 401) return 'Сервер отклонил токен (401). Вероятен принудительный выход и очистка данных пользователя — дальше в логе ищите повторную авторизацию.';
  if (code === 404) return 'Ресурс не найден (404) — заявка удалена или ещё не синхронизирована с сервером.';
  if (code >= 500) return `Ошибка на стороне сервера (${code}) за ${p.durationMs} мс. Запрос мог быть повторён из офлайн-очереди.`;
  if (code === 400) return 'Сервер отверг запрос (400) — обычно ошибка бизнес-валидации или сбой upstream-сервиса.';
  if (p.stackTrace && isBinary(p.stackTrace)) return 'Стек вызовов не сохранён в логе (передан как бинарный блок) — для полной трассировки нужен crash-репорт.';
  if (row.category === 'memoryWarning') return 'Система сигнализировала о нехватке памяти — приложение могло быть выгружено ОС.';
  if (row.category === 'tap' && p.enabled === false) return 'Элемент был недоступен в момент тапа — действие не выполнилось.';
  return '';
}

// ---------- JSON tree (для detail-панели) ----------
// toggles/expandedText ключуются по `${rowId}:${path}`, чтобы не путать
// состояние раскрытия между разными строками.
function walkTree(value, key, path, depth, toggles, out) {
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';
  if (isObj) {
    const entries = isArr ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    const open = toggles[path] === undefined ? depth < 2 : toggles[path];
    out.push({ key, path, depth, branch: true, open, preview: isArr ? `[${entries.length}]` : `{${entries.length}}` });
    if (!open) return;
    const limitKey = `${path}::more`;
    const showAll = toggles[limitKey];
    const cap = showAll ? entries.length : 20;
    entries.slice(0, cap).forEach(([k, v]) => walkTree(v, k, `${path}.${k}`, depth + 1, toggles, out));
    if (entries.length > cap) out.push({ key: '', path: limitKey, depth: depth + 1, moreCount: entries.length - cap });
    return;
  }
  out.push({ key, path, depth, value });
}

class Viewer {
  constructor(root) {
    this.root = root;
    this.state = {
      technicians: [], activeUserId: null, pickerOpen: false, techSearch: '',
      rows: [], hasMoreOlder: false, loadingOlder: false, loading: true, error: null,
      categories: [], timeline: [],
      search: '', activeCats: new Set(), scope: 'all', missionOnly: false,
      catMenuOpen: false, range: null, dragFrom: null, dragTo: null, hoverX: null,
      selectedRowId: null, shortcutsOpen: false,
      toggles: {}, expandedText: {}, copiedKey: null, copied: false, rawOpen: false,
    };
    this.rowNodes = {};
    this.scrollNode = null;
    this.tlNode = null;
    this.onSearchDebounced = debounce(() => this.reloadLogs(), 300);
    this.onKey = (e) => this.handleKey(e);
    window.addEventListener('keydown', this.onKey);
    this.init();
  }

  async init() {
    try {
      const techs = await api('/audit/technicians');
      this.state.technicians = techs;
      this.state.activeUserId = techs.length ? techs[0].userId : null;
      if (this.state.activeUserId) await this.loadTechnicianData();
    } catch (e) {
      this.state.error = String(e);
    }
    this.state.loading = false;
    this.render();
  }

  activeTech() {
    return this.state.technicians.find((t) => t.userId === this.state.activeUserId);
  }

  currentFilters() {
    const s = this.state;
    return {
      search: s.search,
      actionsOnly: s.scope === 'actions',
      errorsOnly: s.scope === 'issues',
      missionOnly: s.missionOnly,
      categories: Array.from(s.activeCats),
    };
  }

  buildLogsURL(userId, beforeId) {
    const f = this.currentFilters();
    const p = new URLSearchParams({ user_id: userId });
    if (f.search) p.set('search', f.search);
    if (f.actionsOnly) p.set('actions_only', '1');
    if (f.errorsOnly) p.set('errors_only', '1');
    if (f.missionOnly) p.set('mission_only', '1');
    if (f.categories.length) p.set('category', f.categories.join(','));
    if (beforeId) p.set('before_id', String(beforeId));
    return `/audit/logs?${p.toString()}`;
  }

  async loadTechnicianData() {
    const userId = this.state.activeUserId;
    this.resetSelection();
    const [cats, timeline] = await Promise.all([
      api(`/audit/technicians/categories?user_id=${encodeURIComponent(userId)}`),
      api(`/audit/technicians/timeline?user_id=${encodeURIComponent(userId)}`),
    ]);
    this.state.categories = cats || [];
    this.state.timeline = timeline || [];
    await this.reloadLogs();
  }

  async reloadLogs() {
    const userId = this.state.activeUserId;
    if (!userId) return;
    this.state.loading = true;
    this.render();
    try {
      const data = await api(this.buildLogsURL(userId));
      this.state.rows = data.rows || [];
      this.state.hasMoreOlder = !!data.hasMore;
    } catch (e) {
      this.state.error = String(e);
    }
    this.state.loading = false;
    this.render();
  }

  async loadEarlier() {
    const userId = this.state.activeUserId;
    if (!userId || !this.state.rows.length || this.state.loadingOlder) return;
    this.state.loadingOlder = true;
    this.render();
    const beforeId = this.state.rows[0].id;
    const prevHeight = this.scrollNode ? this.scrollNode.scrollHeight : 0;
    try {
      const data = await api(this.buildLogsURL(userId, beforeId));
      this.state.rows = (data.rows || []).concat(this.state.rows);
      this.state.hasMoreOlder = !!data.hasMore;
    } catch (e) {
      this.state.error = String(e);
    }
    this.state.loadingOlder = false;
    this.render();
    if (this.scrollNode) this.scrollNode.scrollTop += this.scrollNode.scrollHeight - prevHeight;
  }

  switchTech(userId) {
    this.state.activeUserId = userId;
    this.state.pickerOpen = false;
    this.state.techSearch = '';
    this.state.range = null;
    this.loadTechnicianData().then(() => this.render());
  }

  resetSelection() {
    this.state.selectedRowId = null;
    this.state.toggles = {};
    this.state.expandedText = {};
    this.state.copiedKey = null;
    this.state.copied = false;
    this.state.rawOpen = false;
  }

  // ---------- keyboard ----------
  handleKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') { if (e.key === 'Escape') e.target.blur(); return; }
    const k = e.key;
    if (k === '/') { e.preventDefault(); const el = this.root.querySelector('[data-search]'); if (el) el.focus(); return; }
    if (k === 'Escape') { this.state.selectedRowId = null; this.state.catMenuOpen = false; this.state.pickerOpen = false; this.state.shortcutsOpen = false; this.render(); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); this.step(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); this.step(-1); return; }
    if (k === 'e' || k === 'E') { this.jumpToSeverity('error', e.shiftKey ? -1 : 1); return; }
    if (k === 'w' || k === 'W') { this.jumpToSeverity('warning', e.shiftKey ? -1 : 1); return; }
    if (k === '?') { this.state.shortcutsOpen = !this.state.shortcutsOpen; this.render(); }
  }

  // ---------- row navigation ----------
  visibleRows() {
    const s = this.state;
    if (!s.range) return s.rows;
    return s.rows.filter((r) => { const t = new Date(r.timestamp).getTime(); return t >= s.range[0] && t <= s.range[1]; });
  }

  selectRow(id) {
    this.state.selectedRowId = id;
    this.state.toggles = {};
    this.state.expandedText = {};
    this.state.copiedKey = null;
    this.state.copied = false;
    this.state.rawOpen = false;
    this.render();
    this.scrollToRow(id);
  }

  step(dir) {
    const list = this.visibleRows();
    if (!list.length) return;
    const i = list.findIndex((r) => r.id === this.state.selectedRowId);
    const next = i === -1 ? list[0] : list[Math.max(0, Math.min(list.length - 1, i + dir))];
    this.selectRow(next.id);
  }

  jumpToSeverity(sev, dir) {
    const targets = this.state.timeline.filter((p) => p.logType === sev);
    if (!targets.length) return;
    const loadedIds = new Set(this.state.rows.map((r) => r.id));
    const inLoaded = targets.filter((p) => loadedIds.has(p.id));
    if (inLoaded.length && this.scrollNode) {
      const cur = this.scrollNode.scrollTop;
      const top = (p) => (this.rowNodes[p.id] ? this.rowNodes[p.id].offsetTop : 0);
      let next;
      if (dir > 0) next = inLoaded.find((p) => top(p) > cur + 110) || inLoaded[0];
      else { const before = inLoaded.filter((p) => top(p) < cur + 90); next = before[before.length - 1] || inLoaded[inLoaded.length - 1]; }
      this.selectRow(next.id);
      return;
    }
    // Точка вне загруженной страницы — перегружаем окно, оканчивающееся на этом id.
    const point = dir > 0 ? targets[0] : targets[targets.length - 1];
    this.jumpToMark(point);
  }

  jumpToMark(point) {
    const loadedIds = new Set(this.state.rows.map((r) => r.id));
    if (loadedIds.has(point.id)) { this.selectRow(point.id); return; }
    const userId = this.state.activeUserId;
    api(this.buildLogsURL(userId, point.id + 1)).then((data) => {
      this.state.rows = data.rows || [];
      this.state.hasMoreOlder = !!data.hasMore;
      this.selectRow(point.id);
    });
  }

  scrollToRow(id) {
    requestAnimationFrame(() => {
      const node = this.rowNodes[id];
      if (node && this.scrollNode) this.scrollNode.scrollTop = node.offsetTop - 100;
    });
  }

  // ---------- density timeline ----------
  tlFrac(e) {
    if (!this.tlNode) return 0;
    const b = this.tlNode.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
  }

  seekToTime(t) {
    const list = this.state.rows;
    if (!list.length) return;
    let best = list[0];
    for (const r of list) { if (new Date(r.timestamp).getTime() <= t) best = r; else break; }
    this.selectRow(best.id);
  }

  // ---------- clipboard ----------
  copyText(text, key) {
    try { navigator.clipboard.writeText(text); } catch (e) { /* clipboard недоступен — молча игнорируем */ }
    this.state.copiedKey = key;
    this.render();
  }

  toggleTreePath(path) {
    const cur = this.state.toggles[path];
    this.state.toggles = { ...this.state.toggles, [path]: cur === undefined ? false : !cur };
    this.render();
  }

  // ---------- render ----------
  render() {
    this.rowNodes = {};
    const s = this.state;
    const tech = this.activeTech();
    const focused = document.activeElement;
    const restoreFocus = focused && focused.matches('[data-search], [data-tech-search]')
      ? { selector: focused.hasAttribute('data-search') ? '[data-search]' : '[data-tech-search]', pos: focused.selectionStart }
      : null;

    if (s.loading && !s.technicians.length) {
      this.root.innerHTML = `<div class="empty-state"><div class="empty-title">Загрузка…</div></div>`;
      return;
    }
    if (s.error) {
      this.root.innerHTML = `<div class="empty-state"><div class="empty-title">Ошибка</div><div class="empty-desc">${escapeHtml(s.error)}</div></div>`;
      return;
    }
    if (!s.technicians.length) {
      this.root.innerHTML = `<div class="empty-state"><div class="empty-title">Пока нет записей audit-лога</div></div>`;
      return;
    }

    const visible = this.visibleRows();
    const groups = [];
    visible.forEach((r) => {
      const minute = fmtMinute(r.timestamp);
      let g = groups[groups.length - 1];
      if (!g || g.minute !== minute) { g = { minute, rows: [] }; groups.push(g); }
      g.rows.push(r);
    });

    this.root.innerHTML = `
      ${this.renderTopbar(tech)}
      ${s.pickerOpen ? '<div class="overlay-dismiss" data-close-picker></div>' : ''}
      ${this.renderFilterbar()}
      ${this.renderTimeline()}
      <div class="body-row">
        <div class="list-scroll pt-scroll" data-scroll>
          ${s.hasMoreOlder ? `<button class="load-earlier" data-load-earlier ${s.loadingOlder ? 'disabled' : ''}>${s.loadingOlder ? 'Загрузка…' : 'Загрузить более ранние'}</button>` : ''}
          ${groups.length ? groups.map((g) => this.renderGroup(g)).join('') : this.renderEmptyList()}
        </div>
        ${this.renderDetail()}
      </div>
      ${this.renderStatusbar(visible)}
      ${s.shortcutsOpen ? this.renderShortcuts() : ''}
    `;

    this.scrollNode = this.root.querySelector('[data-scroll]');
    this.tlNode = this.root.querySelector('[data-timeline]');
    this.bind();

    if (restoreFocus) {
      const el = this.root.querySelector(restoreFocus.selector);
      if (el) { el.focus(); el.setSelectionRange(restoreFocus.pos, restoreFocus.pos); }
    }
  }

  renderTopbar(tech) {
    const s = this.state;
    const q = s.techSearch.trim().toLowerCase();
    const items = s.technicians.filter((t) => !q || t.userId.toLowerCase().includes(q) || (t.userLabel || '').toLowerCase().includes(q));
    const initials = (label, id) => (label || id || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const rangeStr = s.rows.length ? `${fmtMinute(s.rows[0].timestamp)}–${fmtMinute(s.rows[s.rows.length - 1].timestamp)}` : '';

    return `
      <div class="topbar">
        <div class="picker-wrap">
          <button class="picker-btn pt-item" data-toggle-picker>
            <div class="avatar" style="background:oklch(0.75 0.14 250 / 0.2);color:oklch(0.8 0.14 250)">${escapeHtml(initials(tech && tech.userLabel, tech && tech.userId))}</div>
            <div>
              <div class="picker-name">${escapeHtml((tech && tech.userLabel) || (tech && tech.userId) || '—')}</div>
              <div class="picker-id">${escapeHtml((tech && tech.userId) || '')}</div>
            </div>
            <span class="picker-caret">▾</span>
          </button>
          ${s.pickerOpen ? `
            <div class="picker-menu" data-stop>
              <input class="picker-search" data-tech-search value="${escapeHtml(s.techSearch)}" placeholder="Техник: имя или ID…" autofocus>
              <div class="picker-list pt-scroll">
                ${items.map((t) => `
                  <div class="pt-item" data-select-tech="${escapeHtml(t.userId)}" style="display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:8px;cursor:pointer;background:${t.userId === s.activeUserId ? '#ffffff0d' : 'transparent'}">
                    <div class="avatar" style="width:26px;height:26px;background:oklch(0.75 0.13 160 / 0.2);color:oklch(0.8 0.13 160)">${escapeHtml(initials(t.userLabel, t.userId))}</div>
                    <div style="min-width:0;flex:1">
                      <div class="picker-item-name">${escapeHtml(t.userLabel || t.userId)}</div>
                      <div class="picker-item-id">${escapeHtml(t.userId)}</div>
                    </div>
                    ${t.userId === s.activeUserId ? '<span class="picker-active-tag">открыт</span>' : ''}
                    ${t.errors > 0 ? '<span class="picker-error-tag">есть ошибки</span>' : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>

        <div class="device-info">${['device', tech && tech.deviceModel, '·', [tech && tech.platform, tech && tech.osVersion].filter(Boolean).join(' '), '·', tech && tech.appVersion].filter((x) => x && x !== 'device').map(escapeHtml).join('')}</div>
        <span class="session-range">${escapeHtml(rangeStr)}</span>

        <div class="topbar-actions">
          <div class="nav-group nav-group-error">
            <span class="nav-count">${tech ? tech.errors : 0} ошибок</span>
            <button class="nav-btn pt-btn" data-jump="error" data-dir="-1" title="Предыдущая ошибка (Shift+E)">↑</button>
            <button class="nav-btn pt-btn" data-jump="error" data-dir="1" title="Следующая ошибка (E)">↓</button>
          </div>
          <div class="nav-group nav-group-warning">
            <span class="nav-count">${tech ? tech.warnings : 0} предупр.</span>
            <button class="nav-btn pt-btn" data-jump="warning" data-dir="-1" title="Предыдущее (Shift+W)">↑</button>
            <button class="nav-btn pt-btn" data-jump="warning" data-dir="1" title="Следующее (W)">↓</button>
          </div>
          <button class="icon-btn pt-item" data-toggle-shortcuts title="Горячие клавиши (?)">?</button>
        </div>
      </div>
    `;
  }

  renderFilterbar() {
    const s = this.state;
    const scopeDefs = [['all', 'Все'], ['actions', 'Действия'], ['issues', 'Проблемы']];
    const counts = {
      all: s.rows.length,
      actions: s.rows.filter((r) => ACTION_CATEGORIES.has(r.category)).length,
      issues: s.rows.filter((r) => r.logType !== 'info').length,
    };

    const catCounts = {};
    s.rows.forEach((r) => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
    const catGroups = Object.keys(KIND_META).map((kind) => ({
      title: KIND_META[kind].ru,
      items: Object.keys(catCounts).filter((c) => kindOf(c) === kind).sort((a, b) => catCounts[b] - catCounts[a]),
    })).filter((g) => g.items.length);

    const catActive = s.activeCats.size > 0;
    const catLabel = catActive ? `Категории · ${s.activeCats.size}` : 'Все категории';
    const anyFilter = !!(s.search || s.activeCats.size || s.scope !== 'all' || s.missionOnly || s.range);
    const rangeChip = s.range ? `${fmtMinute(new Date(s.range[0]))}–${fmtMinute(new Date(s.range[1]))}` : '';

    return `
      <div class="filterbar">
        <div class="search-wrap">
          <span class="search-icon">⌕</span>
          <input class="search-main" data-search value="${escapeHtml(s.search)}" placeholder="Поиск: событие, category, payload…  ( / )">
        </div>

        <div class="scope-tabs">
          ${scopeDefs.map(([k, label]) => `
            <button class="scope-tab" data-scope="${k}" style="background:${s.scope === k ? '#ffffff14' : 'transparent'};color:${s.scope === k ? '#f1f2f4' : '#8b9199'}">${label}<span class="scope-tab-count" style="color:${s.scope === k ? '#8b9199' : '#5c626c'}">${counts[k]}</span></button>
          `).join('')}
        </div>

        <button class="mission-toggle" data-toggle-mission style="${s.missionOnly
          ? 'background:oklch(0.75 0.14 250 / 0.2);border-color:oklch(0.75 0.14 250 / 0.5);color:oklch(0.85 0.12 250)'
          : 'background:#ffffff0a;border-color:#ffffff18;color:#9298a1'}">Только заявки</button>

        <div class="cat-menu-wrap">
          <button class="cat-menu-btn pt-item" data-toggle-catmenu style="background:${catActive ? 'oklch(0.75 0.14 250 / 0.16)' : '#15181d'};border-color:${catActive ? 'oklch(0.75 0.14 250 / 0.45)' : '#ffffff1a'};color:${catActive ? 'oklch(0.86 0.1 250)' : '#9298a1'}">${escapeHtml(catLabel)}<span style="color:#6b7178;font:10px system-ui">▾</span></button>
          ${s.catMenuOpen ? `
            <div class="cat-menu" data-stop>
              <div class="cat-menu-list pt-scroll">
                ${catGroups.map((g) => `
                  <div>
                    <div class="cat-group-title">${escapeHtml(g.title)}</div>
                    ${g.items.map((c) => {
                      const on = s.activeCats.has(c);
                      return `
                        <div class="cat-item pt-item" data-toggle-cat="${escapeHtml(c)}">
                          <span class="cat-check" style="border-color:${on ? 'oklch(0.8 0.13 250)' : '#ffffff2e'};background:${on ? 'oklch(0.8 0.13 250)' : 'transparent'}">${on ? '✓' : ''}</span>
                          <span class="cat-swatch" style="background:${categoryColor(c, 1)}"></span>
                          <span class="cat-label">${escapeHtml(c)}</span>
                          <span class="cat-count">${catCounts[c]}</span>
                        </div>
                      `;
                    }).join('')}
                  </div>
                `).join('')}
              </div>
              <div class="cat-menu-actions">
                <button data-clear-cats>Показать все</button>
                <button data-toggle-catmenu>Готово</button>
              </div>
            </div>
          ` : ''}
        </div>

        ${rangeChip ? `<button class="range-chip" data-clear-range>${escapeHtml(rangeChip)}<span style="opacity:.7">✕</span></button>` : ''}

        <div class="filterbar-right">
          ${anyFilter ? '<button class="reset-link" data-reset-all>сбросить фильтры</button>' : ''}
          <span class="count-label"><b>${s.rows.length}</b> строк на странице</span>
        </div>
      </div>
    `;
  }

  renderTimeline() {
    const s = this.state;
    const rows = s.rows;
    if (!rows.length) {
      return `<div class="timeline-wrap"><div class="timeline-caption">Нет загруженных событий</div></div>`;
    }
    const t0 = new Date(rows[0].timestamp).getTime();
    const t1 = new Date(rows[rows.length - 1].timestamp).getTime();
    const span = Math.max(t1 - t0, 1);

    const N = 132;
    const buckets = Array.from({ length: N }, () => ({ n: 0, err: 0, warn: 0 }));
    rows.forEach((r) => {
      const b = buckets[Math.min(N - 1, Math.floor(((new Date(r.timestamp).getTime() - t0) / span) * N))];
      b.n++;
      if (r.logType === 'error') b.err++;
      if (r.logType === 'warning') b.warn++;
    });
    const maxN = Math.max(1, ...buckets.map((b) => b.n));
    const bars = buckets.map((b, i) => ({
      left: (i * 100) / N, width: 100 / N - 0.12,
      h: b.n ? Math.max(3, Math.round((Math.log(1 + b.n) / Math.log(1 + maxN)) * 32)) : 1,
      color: b.err ? SEVERITY_COLOR.error : b.warn ? SEVERITY_COLOR.warning : '#3b4149',
      opacity: b.n ? (b.err || b.warn ? 1 : 0.75) : 0.25,
      title: `${fmtMinute(new Date(t0 + (span * (i + 0.5)) / N))} · ${b.n} событий${b.err ? ` · ${b.err} error` : ''}${b.warn ? ` · ${b.warn} warning` : ''}`,
    }));

    const hourTicks = [];
    const step = span > 3600000 ? 1800000 : 60000;
    const start = new Date(rows[0].timestamp); start.setUTCSeconds(0, 0);
    for (let c = start.getTime(); c <= t1; c += step) {
      const left = ((c - t0) / span) * 100;
      if (left < 0) continue;
      hourTicks.push({ left, label: fmtMinute(new Date(c)) });
    }

    const dragBox = s.dragFrom !== null && s.dragTo !== null && Math.abs(s.dragTo - s.dragFrom) > 0.004
      ? { left: Math.min(s.dragFrom, s.dragTo) * 100, width: Math.abs(s.dragTo - s.dragFrom) * 100 } : null;
    const hoverLine = s.hoverX !== null ? { left: s.hoverX * 100, label: fmtMinute(new Date(t0 + span * s.hoverX)) } : null;

    return `
      <div class="timeline-wrap">
        <div class="timeline-head">
          <span class="timeline-caption">Плотность событий загруженной страницы — клик перемещает по логу, протяните для выбора интервала</span>
          <div class="timeline-legend">
            <span class="timeline-legend-item"><span class="swatch" style="background:#3b4149"></span>обычные</span>
            <span class="timeline-legend-item"><span class="swatch" style="background:${SEVERITY_COLOR.warning}"></span>warning</span>
            <span class="timeline-legend-item"><span class="swatch" style="background:${SEVERITY_COLOR.error}"></span>error</span>
          </div>
        </div>
        <div class="timeline-track" data-timeline>
          <div class="timeline-bars">
            ${bars.map((b) => `<div class="timeline-bar pt-bar" title="${escapeHtml(b.title)}" style="left:${b.left}%;width:${b.width}%;height:${b.h}px;background:${b.color};opacity:${b.opacity}"></div>`).join('')}
            ${dragBox ? `<div class="timeline-dragbox" style="left:${dragBox.left}%;width:${dragBox.width}%"></div>` : ''}
          </div>
          <div class="timeline-baseline"></div>
          ${hourTicks.map((t) => `<div class="timeline-tick" style="left:${t.left}%">${escapeHtml(t.label)}</div>`).join('')}
          ${hoverLine ? `
            <div class="timeline-hover-line" style="left:${hoverLine.left}%"></div>
            <div class="timeline-hover-label" style="left:${hoverLine.left}%">${escapeHtml(hoverLine.label)}</div>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderEmptyList() {
    return `
      <div class="empty-state">
        <div class="empty-title">Ничего не найдено</div>
        <div class="empty-desc">Фильтры отсекли все события загруженной страницы. Сбросьте их и попробуйте более широкий запрос.</div>
        <button class="empty-btn pt-item" data-reset-all>Сбросить фильтры</button>
      </div>
    `;
  }

  renderGroup(group) {
    const errCount = group.rows.filter((r) => r.logType === 'error').length;
    return `
      <div>
        <div class="group-head">
          <span class="group-minute">${escapeHtml(group.minute)}</span>
          <span class="group-count">${group.rows.length} событий</span>
          ${errCount ? `<span class="group-err-badge">${errCount} ERROR</span>` : ''}
        </div>
        ${group.rows.map((r) => this.renderRow(r)).join('')}
      </div>
    `;
  }

  renderRow(r) {
    const s = this.state;
    const isAction = ACTION_CATEGORIES.has(r.category);
    const isDisabledTap = r.category === 'tap' && r.payload && r.payload.enabled === false;
    const sev = r.logType;
    const selected = r.id === s.selectedRowId;
    const rowBg = selected ? 'oklch(0.75 0.14 250 / 0.16)' : sev === 'error' ? 'oklch(0.68 0.19 25 / 0.07)' : sev === 'warning' ? 'oklch(0.82 0.15 80 / 0.055)' : 'transparent';
    const edgeColor = selected ? 'oklch(0.78 0.13 250)' : sev === 'error' ? SEVERITY_COLOR.error : sev === 'warning' ? SEVERITY_COLOR.warning : 'transparent';
    const dotColor = sev === 'error' ? SEVERITY_COLOR.error : sev === 'warning' ? SEVERITY_COLOR.warning : isAction ? '#8b9199' : '#33373d';
    const dotSize = isAction ? 7 : 5;
    const height = isAction ? 36 : 29;
    const badge = isDisabledTap ? 'disabled' : sev !== 'info' ? sev : '';
    const badgeColor = isDisabledTap ? '#c7cad0' : sev === 'error' ? 'oklch(0.85 0.1 25)' : 'oklch(0.88 0.1 80)';
    const badgeBg = isDisabledTap ? '#ffffff14' : sev === 'error' ? 'oklch(0.68 0.19 25 / 0.22)' : 'oklch(0.82 0.15 80 / 0.2)';

    return `
      <div class="pt-row" data-select-row="${r.id}" style="min-height:${height}px;background:${rowBg};box-shadow:inset 3px 0 0 ${edgeColor}">
        <div class="row-time-col">
          <span class="row-dot" style="width:${dotSize}px;height:${dotSize}px;background:${dotColor}"></span>
          <span class="row-time" style="color:${isAction ? '#9298a1' : '#6f757e'}">${escapeHtml(fmtHms(r.timestamp))}<span class="row-ms">${escapeHtml(fmtMs(r.timestamp))}</span></span>
        </div>
        <div><span class="cat-badge" style="background:${categoryColor(r.category, 0.14)};color:${categoryColor(r.category, 1)}">${escapeHtml(r.category)}</span></div>
        <div class="row-name-col">
          <span class="row-name" style="font:${isAction ? 600 : 400} ${isAction ? 13 : 12}px system-ui;color:${isDisabledTap ? '#9298a1' : isAction ? '#f1f2f4' : '#959ba4'}">${escapeHtml(r.eventName)}</span>
          <span class="row-meta">${escapeHtml(metaFor(r.category, r.payload))}</span>
        </div>
        <div class="row-badge-col">${badge ? `<span class="row-badge" style="color:${badgeColor};background:${badgeBg}">${escapeHtml(badge)}</span>` : ''}</div>
      </div>
    `;
  }

  // ---------- detail ----------
  buildFacts(row, p) {
    const facts = [];
    const consumed = new Set();
    const neutral = { bg: '#15181d', border: '#ffffff14', fg: '#e6e8ec' };
    const good = { bg: 'oklch(0.78 0.13 160 / 0.1)', border: 'oklch(0.78 0.13 160 / 0.35)', fg: 'oklch(0.85 0.12 160)' };
    const bad = { bg: 'oklch(0.68 0.19 25 / 0.12)', border: 'oklch(0.68 0.19 25 / 0.4)', fg: 'oklch(0.85 0.12 25)' };
    const warn = { bg: 'oklch(0.82 0.15 80 / 0.1)', border: 'oklch(0.82 0.15 80 / 0.35)', fg: 'oklch(0.88 0.11 80)' };
    const fact = (label, value, tone) => facts.push({ label, value, ...(tone || neutral) });

    if (!p || typeof p !== 'object') return { facts, consumed };

    if (row.category === 'http') {
      const code = p.statusCode;
      if (code !== undefined) fact('статус', String(code), code >= 500 ? bad : code >= 400 ? warn : good);
      if (p.method) fact('метод', p.method, neutral);
      if (p.durationMs !== undefined) fact('время', `${p.durationMs} мс`, p.durationMs > 1000 ? warn : neutral);
      ['statusCode', 'method', 'durationMs', 'path'].forEach((k) => consumed.add(k));
    } else if (row.category === 'tap' || row.category === 'swipe') {
      if (p.route !== undefined) fact('экран', p.route || '—', neutral);
      if (p.x !== undefined) fact('координаты', `${Math.round(p.x)} × ${Math.round(p.y || 0)}`, neutral);
      if (p.enabled !== undefined) fact('доступен', p.enabled === null ? 'null' : String(p.enabled), p.enabled === false ? warn : neutral);
      ['route', 'x', 'y', 'enabled', 'identifier', 'label'].forEach((k) => consumed.add(k));
    } else if (row.category === 'blocEvent') {
      if (p.bloc) fact('bloc', p.bloc, neutral);
      if (p.event) fact('событие', p.event, neutral);
      ['bloc', 'event'].forEach((k) => consumed.add(k));
    }
    return { facts, consumed };
  }

  renderDetail() {
    const s = this.state;
    const row = s.rows.find((r) => r.id === s.selectedRowId);
    if (!row) return '';
    const p = row.payload && typeof row.payload === 'object' ? row.payload : null;
    const sev = row.logType;
    const badge = sev !== 'info' ? sev : '';
    const badgeColor = sev === 'error' ? 'oklch(0.85 0.1 25)' : 'oklch(0.88 0.1 80)';
    const badgeBg = sev === 'error' ? 'oklch(0.68 0.19 25 / 0.22)' : 'oklch(0.82 0.15 80 / 0.2)';
    const hint = hintFor(row, p || {});
    const hintBg = sev === 'error' ? 'oklch(0.68 0.19 25 / 0.1)' : sev === 'warning' ? 'oklch(0.82 0.15 80 / 0.08)' : '#ffffff08';
    const hintBorder = sev === 'error' ? 'oklch(0.68 0.19 25 / 0.36)' : sev === 'warning' ? 'oklch(0.82 0.15 80 / 0.3)' : '#ffffff18';
    const hintFg = sev === 'error' ? 'oklch(0.9 0.07 25)' : sev === 'warning' ? 'oklch(0.91 0.07 80)' : '#c7cad0';

    const visible = this.visibleRows();
    const pos = visible.findIndex((r) => r.id === row.id);
    const positionLabel = pos >= 0 ? `${(pos + 1).toLocaleString('ru-RU')} из ${visible.length.toLocaleString('ru-RU')}` : 'вне текущего фильтра';

    const { facts, consumed } = this.buildFacts(row, p);
    const textBlocks = [];
    const trees = [];

    if (p && typeof p === 'object') {
      if (p.exception) { textBlocks.push({ key: 'exception', title: 'Исключение', text: String(p.exception), note: '' }); consumed.add('exception'); }
      if (p.stackTrace !== undefined) {
        consumed.add('stackTrace');
        const bin = isBinary(p.stackTrace);
        textBlocks.push({ key: 'stackTrace', title: 'Stack trace', text: bin ? `${p.stackTrace}\n\nСтек не сохранён в базе логов — доступен только размер блока.` : String(p.stackTrace), note: bin ? 'бинарный блок' : '' });
      }
      const rest = {};
      Object.entries(p).forEach(([k, v]) => { if (!consumed.has(k)) rest[k] = v; });
      if (Object.keys(rest).length) trees.push({ key: 'payload', title: facts.length ? 'Остальной payload' : 'Payload', value: rest });
    } else if (typeof row.payload === 'string' && row.payload) {
      textBlocks.push({ key: 'payloadRaw', title: 'Payload (не JSON)', text: row.payload, note: '' });
    }

    const T = s.expandedText;
    const rowKey = (k) => `${row.id}:${k}`;
    const finishedTextBlocks = textBlocks.map((b) => {
      const full = b.text;
      const limit = 1200;
      const long = full.length > limit;
      const open = !!T[rowKey(b.key)];
      const shown = long && !open ? `${full.slice(0, limit)}\n…` : full;
      return {
        title: b.title, note: b.note, text: shown, canExpand: long,
        expandLabel: open ? 'Свернуть' : `Показать полностью (${full.length.toLocaleString('ru-RU')} символов)`,
        key: b.key, copyLabel: s.copiedKey === rowKey(b.key) ? 'скопировано ✓' : 'копировать',
        fullText: full,
      };
    });

    const toggles = s.toggles;
    const finishedTrees = trees.map((t) => {
      const json = JSON.stringify(t.value, null, 2);
      const lines = json.split('\n').length;
      const rawNodes = [];
      walkTree(t.value, '', rowKey(t.key), 0, toggles, rawNodes);
      const nodes = rawNodes.map((n) => {
        const indent = 12 + n.depth * 14;
        if (n.moreCount !== undefined) {
          return { indent, chev: '', key: '', value: `… ещё ${n.moreCount}`, keyColor: '#5c626c', valColor: '#6ea8fe', cursor: 'pointer', more: 'показать', path: n.path };
        }
        if (n.branch) {
          return { indent, chev: n.open ? '▾' : '▸', key: n.key === '' ? '' : `${n.key}:`, value: n.preview, keyColor: '#c7cad0', valColor: '#5c626c', cursor: 'pointer', more: '', path: n.path };
        }
        const v = n.value;
        let text, color;
        if (v === null) { text = 'null'; color = '#5c626c'; }
        else if (typeof v === 'boolean') { text = String(v); color = v ? 'oklch(0.78 0.13 160)' : 'oklch(0.74 0.14 25)'; }
        else if (typeof v === 'number') { text = String(v); color = 'oklch(0.82 0.13 70)'; }
        else if (isBinary(v)) { text = `${v} — не сохранено в логе`; color = '#7d838d'; }
        else { text = String(v); color = '#c3cad3'; }
        const long = text.length > 130;
        const open = !!T[n.path];
        const shown = long && !open ? `${text.slice(0, 130)}…` : text;
        return {
          indent, chev: '', key: n.key === '' ? '' : `${n.key}:`, value: shown, keyColor: '#8f96a0', valColor: color,
          cursor: long ? 'pointer' : 'default', more: long ? (open ? 'свернуть' : `+${text.length - 130} символов`) : '',
          path: long ? `expand:${n.path}` : null,
        };
      });
      return { title: t.title, note: `${lines.toLocaleString('ru-RU')} строк JSON`, nodes, key: t.key, copyLabel: s.copiedKey === rowKey(t.key) ? 'скопировано ✓' : 'копировать JSON', json };
    });

    const dim = '#ffffff14';
    const perms = row.permissions && typeof row.permissions === 'object' ? row.permissions : {};
    const contextChips = [
      { label: 'техник', value: row.userLabel || row.userId || '—', color: '#c7cad0', border: dim },
      { label: 'устройство', value: [row.deviceModel, row.platform, row.osVersion].filter(Boolean).join(' · '), color: '#c7cad0', border: dim },
      { label: 'версия приложения', value: row.appVersion || '—', color: '#c7cad0', border: dim },
      { label: 'сеть', value: row.networkType ? `${row.networkType}${row.networkSignalLevel == null ? '' : ` · сигнал ${row.networkSignalLevel}`}` : '—', color: '#c7cad0', border: dim },
      { label: 'батарея', value: row.batteryLevel != null ? `${row.batteryLevel}% · ${row.batteryState || ''}` : '—', color: row.batteryLevel != null && row.batteryLevel < 25 ? 'oklch(0.78 0.14 25)' : '#c7cad0', border: row.batteryLevel != null && row.batteryLevel < 25 ? 'oklch(0.68 0.19 25 / 0.3)' : dim },
      { label: 'энергосбережение', value: row.powerSaveMode != null ? (row.powerSaveMode ? 'вкл' : 'выкл') : '—', color: row.powerSaveMode ? 'oklch(0.82 0.15 80)' : '#c7cad0', border: dim },
      { label: 'device_id', value: row.deviceId || '—', color: '#9aa2ac', border: dim },
      { label: 'разрешения', value: Object.entries(perms).map(([k, v]) => `${k}: ${v}`).join(', ') || '—', color: Object.values(perms).some((v) => v === 'denied') ? 'oklch(0.78 0.14 25)' : '#9aa2ac', border: dim },
    ];

    const rawJson = JSON.stringify(row, null, 2);

    return `
      <div class="detail-panel pt-scroll">
        <div class="detail-head">
          <button class="detail-nav-btn pt-item" data-select-prev title="Предыдущее (K / ↑)">↑</button>
          <button class="detail-nav-btn pt-item" data-select-next title="Следующее (J / ↓)">↓</button>
          <span class="detail-pos">${escapeHtml(positionLabel)}</span>
          <button class="detail-copy-btn pt-item" data-copy-json>${s.copied ? 'Скопировано ✓' : 'Копировать всё'}</button>
          <button class="detail-nav-btn pt-item" data-close-detail title="Esc">✕</button>
        </div>

        <div class="detail-inner">
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="detail-top-row">
              <span class="cat-badge" style="background:${categoryColor(row.category, 0.14)};color:${categoryColor(row.category, 1)}">${escapeHtml(row.category)}</span>
              ${badge ? `<span class="row-badge" style="color:${badgeColor};background:${badgeBg}">${escapeHtml(badge)}</span>` : ''}
              <span class="detail-full-time">${escapeHtml(fmtFullTime(row.timestamp))}</span>
            </div>
            <div class="detail-title">${escapeHtml(row.eventName)}</div>
            ${hint ? `<div class="detail-hint" style="background:${hintBg};border-color:${hintBorder};color:${hintFg}">${escapeHtml(hint)}</div>` : ''}
          </div>

          ${facts.length ? `
            <div class="facts-row">
              ${facts.map((f) => `
                <div class="fact-chip" style="background:${f.bg};border-color:${f.border}">
                  <div class="fact-label">${escapeHtml(f.label)}</div>
                  <div class="fact-value" style="color:${f.fg}">${escapeHtml(f.value)}</div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${finishedTextBlocks.map((tb) => `
            <div>
              <div class="text-block-head">
                <span class="section-title">${escapeHtml(tb.title)}</span>
                ${tb.note ? `<span class="text-block-note">${escapeHtml(tb.note)}</span>` : ''}
                <button class="text-block-copy pt-item" data-copy-text="${rowKey(tb.key)}">${escapeHtml(tb.copyLabel)}</button>
              </div>
              <pre class="text-block-pre pt-scroll">${escapeHtml(tb.text)}</pre>
              ${tb.canExpand ? `<button class="text-block-expand" data-expand-text="${rowKey(tb.key)}">${escapeHtml(tb.expandLabel)}</button>` : ''}
            </div>
          `).join('')}

          ${finishedTrees.map((tr) => `
            <div>
              <div class="text-block-head">
                <span class="section-title">${escapeHtml(tr.title)}</span>
                <span class="text-block-note">${escapeHtml(tr.note)}</span>
                <button class="text-block-copy pt-item" data-copy-tree="${rowKey(tr.key)}">${escapeHtml(tr.copyLabel)}</button>
              </div>
              <div class="tree-box pt-scroll" style="max-height:340px">
                ${tr.nodes.map((n) => `
                  <div class="tree-node pt-node" ${n.path ? `data-tree-toggle="${escapeHtml(n.path)}"` : ''} style="padding-left:${n.indent}px;cursor:${n.cursor}">
                    <span class="tree-chev">${n.chev}</span>
                    ${n.key ? `<span class="tree-key" style="color:${n.keyColor}">${escapeHtml(n.key)}</span>` : ''}
                    <span class="tree-value" style="color:${n.valColor}">${escapeHtml(n.value)}</span>
                    ${n.more ? `<span class="tree-more">${escapeHtml(n.more)}</span>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}

          ${!p ? '<div class="no-payload">У события нет payload — вся информация в заголовке и контексте сессии.</div>' : ''}

          <div>
            <div class="section-title" style="margin-bottom:8px">Сессия и устройство в этот момент</div>
            <div class="context-grid">
              ${contextChips.map((c) => `
                <div class="context-chip" style="border-color:${c.border}">
                  <div class="context-chip-label">${escapeHtml(c.label)}</div>
                  <div class="context-chip-value" style="color:${c.color}">${escapeHtml(c.value)}</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div>
            <button class="raw-toggle-btn pt-item" data-toggle-raw>${s.rawOpen ? 'Скрыть сырую запись ▴' : 'Показать сырую запись (JSON) ▾'}</button>
            ${s.rawOpen ? `<pre class="raw-json pt-scroll">${escapeHtml(rawJson)}</pre>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderStatusbar(visible) {
    const s = this.state;
    const sel = s.rows.find((r) => r.id === s.selectedRowId);
    const statusLine = sel
      ? `${fmtHms(sel.timestamp)} · ${sel.category} · ${sel.eventName}`
      : s.rows.length
        ? `Страница ${fmtMinute(s.rows[0].timestamp)}–${fmtMinute(s.rows[s.rows.length - 1].timestamp)} · ${visible.length.toLocaleString('ru-RU')} событий в выборке`
        : 'Нет загруженных событий';
    return `
      <div class="statusbar">
        <span class="statusbar-line">${escapeHtml(statusLine)}</span>
        <span class="statusbar-hints">
          <span><kbd>J/K</kbd> навигация</span>
          <span><kbd>E/W</kbd> к проблеме</span>
          <span><kbd>/</kbd> поиск</span>
          <span><kbd>Esc</kbd> закрыть</span>
        </span>
      </div>
    `;
  }

  renderShortcuts() {
    const rows = [
      { key: 'J / ↓', desc: 'следующее событие' }, { key: 'K / ↑', desc: 'предыдущее событие' },
      { key: 'E', desc: 'к следующей ошибке' }, { key: '⇧E', desc: 'к предыдущей ошибке' },
      { key: 'W', desc: 'к следующему предупреждению' }, { key: '⇧W', desc: 'к предыдущему' },
      { key: '/', desc: 'фокус в поиск' }, { key: 'Esc', desc: 'закрыть панель' },
      { key: '?', desc: 'эта справка' },
    ];
    const s = this.state;
    const kindCounts = {};
    s.rows.forEach((r) => { const k = kindOf(r.category); kindCounts[k] = (kindCounts[k] || 0) + 1; });

    return `
      <div class="modal-backdrop" data-close-shortcuts>
        <div class="shortcuts-modal" data-stop>
          <div class="modal-head">
            <span class="modal-title">Горячие клавиши и обозначения</span>
            <button class="close-btn pt-item" data-close-shortcuts>Закрыть ✕</button>
          </div>
          <div class="shortcut-grid">
            ${rows.map((r) => `<div class="shortcut-row"><span class="shortcut-key">${escapeHtml(r.key)}</span><span class="shortcut-desc">${escapeHtml(r.desc)}</span></div>`).join('')}
          </div>
          <div class="hr"></div>
          <div class="kind-legend">
            ${Object.keys(KIND_META).map((k) => `
              <div class="kind-row">
                <span class="kind-dot" style="background:oklch(0.78 ${KIND_META[k].chroma} ${KIND_META[k].hue})"></span>
                <span class="kind-label">${escapeHtml(KIND_META[k].ru)}</span>
                <span class="kind-count">${kindCounts[k] || 0}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- events ----------
  bind() {
    const s = this.state;
    const root = this.root;

    root.querySelectorAll('[data-select-row]').forEach((el) => {
      const id = Number(el.getAttribute('data-select-row'));
      this.rowNodes[id] = el;
      el.addEventListener('click', () => this.selectRow(id));
    });

    root.querySelectorAll('[data-close-detail]').forEach((el) => el.addEventListener('click', () => { s.selectedRowId = null; this.render(); }));
    const selectNext = root.querySelector('[data-select-next]');
    if (selectNext) selectNext.addEventListener('click', () => this.step(1));
    const selectPrev = root.querySelector('[data-select-prev]');
    if (selectPrev) selectPrev.addEventListener('click', () => this.step(-1));

    const toggle = root.querySelector('[data-toggle-picker]');
    if (toggle) toggle.addEventListener('click', () => { s.pickerOpen = !s.pickerOpen; s.techSearch = ''; this.render(); });
    const closePicker = root.querySelector('[data-close-picker]');
    if (closePicker) closePicker.addEventListener('click', () => { s.pickerOpen = false; this.render(); });
    root.querySelectorAll('[data-stop]').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
    const techSearchInput = root.querySelector('[data-tech-search]');
    if (techSearchInput) techSearchInput.addEventListener('input', (e) => { s.techSearch = e.target.value; this.render(); });
    root.querySelectorAll('[data-select-tech]').forEach((el) => {
      el.addEventListener('click', () => this.switchTech(el.getAttribute('data-select-tech')));
    });

    root.querySelectorAll('[data-jump]').forEach((el) => {
      el.addEventListener('click', () => this.jumpToSeverity(el.getAttribute('data-jump'), Number(el.getAttribute('data-dir'))));
    });

    root.querySelectorAll('[data-toggle-shortcuts]').forEach((el) => el.addEventListener('click', () => { s.shortcutsOpen = !s.shortcutsOpen; this.render(); }));
    root.querySelectorAll('[data-close-shortcuts]').forEach((el) => el.addEventListener('click', () => { s.shortcutsOpen = false; this.render(); }));

    const searchInput = root.querySelector('[data-search]');
    if (searchInput) searchInput.addEventListener('input', (e) => { s.search = e.target.value; this.onSearchDebounced(); });

    root.querySelectorAll('[data-scope]').forEach((el) => {
      el.addEventListener('click', () => { s.scope = el.getAttribute('data-scope'); this.reloadLogs(); });
    });
    const missionToggle = root.querySelector('[data-toggle-mission]');
    if (missionToggle) missionToggle.addEventListener('click', () => { s.missionOnly = !s.missionOnly; this.reloadLogs(); });

    const toggleCatMenu = root.querySelector('[data-toggle-catmenu]');
    if (toggleCatMenu) toggleCatMenu.addEventListener('click', () => { s.catMenuOpen = !s.catMenuOpen; this.render(); });
    root.querySelectorAll('[data-toggle-catmenu]').forEach((el) => el.addEventListener('click', () => { s.catMenuOpen = !s.catMenuOpen; this.render(); }));
    root.querySelectorAll('[data-toggle-cat]').forEach((el) => {
      el.addEventListener('click', () => {
        const cat = el.getAttribute('data-toggle-cat');
        if (s.activeCats.has(cat)) s.activeCats.delete(cat); else s.activeCats.add(cat);
        this.reloadLogs();
      });
    });
    const clearCats = root.querySelector('[data-clear-cats]');
    if (clearCats) clearCats.addEventListener('click', () => { s.activeCats = new Set(); this.reloadLogs(); });

    const clearRange = root.querySelector('[data-clear-range]');
    if (clearRange) clearRange.addEventListener('click', () => { s.range = null; this.render(); });
    const resetAll = root.querySelectorAll('[data-reset-all]');
    resetAll.forEach((el) => el.addEventListener('click', () => {
      s.search = ''; s.activeCats = new Set(); s.scope = 'all'; s.missionOnly = false; s.range = null;
      this.reloadLogs();
    }));

    const loadEarlier = root.querySelector('[data-load-earlier]');
    if (loadEarlier) loadEarlier.addEventListener('click', () => this.loadEarlier());

    // ---- density timeline drag / hover / click-seek ----
    const tl = root.querySelector('[data-timeline]');
    if (tl && s.rows.length) {
      const t0 = new Date(s.rows[0].timestamp).getTime();
      const t1 = new Date(s.rows[s.rows.length - 1].timestamp).getTime();
      const span = Math.max(t1 - t0, 1);
      tl.addEventListener('mousedown', (e) => { const f = this.tlFrac(e); s.dragFrom = f; s.dragTo = f; this.render(); });
      tl.addEventListener('mousemove', (e) => {
        const f = this.tlFrac(e);
        if (s.dragFrom !== null) { s.dragTo = f; s.hoverX = f; } else { s.hoverX = f; }
        this.render();
      });
      tl.addEventListener('mouseup', (e) => {
        const f = this.tlFrac(e);
        const from = s.dragFrom;
        if (from !== null && Math.abs(f - from) > 0.012) {
          s.range = [t0 + span * Math.min(from, f), t0 + span * Math.max(from, f)];
          s.dragFrom = null; s.dragTo = null;
          this.render();
        } else {
          s.dragFrom = null; s.dragTo = null;
          this.seekToTime(t0 + span * f);
        }
      });
      tl.addEventListener('mouseleave', () => { s.hoverX = null; s.dragFrom = null; s.dragTo = null; this.render(); });
    }

    // ---- detail: copy / expand / raw / tree toggle ----
    const copyJsonBtn = root.querySelector('[data-copy-json]');
    if (copyJsonBtn) copyJsonBtn.addEventListener('click', () => {
      const row = s.rows.find((r) => r.id === s.selectedRowId);
      if (!row) return;
      this.copyText(JSON.stringify(row, null, 2), null);
      s.copied = true;
      this.render();
    });
    root.querySelectorAll('[data-copy-text]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = s.rows.find((r) => r.id === s.selectedRowId);
        if (!row) return;
        const key = el.getAttribute('data-copy-text');
        const field = key.split(':').slice(1).join(':');
        const p = row.payload || {};
        const text = field === 'exception' ? String(p.exception) : field === 'stackTrace' ? String(p.stackTrace) : field === 'payloadRaw' ? String(row.payload) : '';
        this.copyText(text, key);
      });
    });
    root.querySelectorAll('[data-copy-tree]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = s.rows.find((r) => r.id === s.selectedRowId);
        if (!row) return;
        const key = el.getAttribute('data-copy-tree');
        const p = row.payload || {};
        const value = p; // единственное дерево на панели — «остальной payload»
        this.copyText(JSON.stringify(value, null, 2), key);
      });
    });
    root.querySelectorAll('[data-expand-text]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-expand-text');
        s.expandedText = { ...s.expandedText, [key]: !s.expandedText[key] };
        this.render();
      });
    });
    root.querySelectorAll('[data-tree-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const path = el.getAttribute('data-tree-toggle');
        const real = path.startsWith('expand:') ? path.slice(7) : path;
        this.toggleTreePath(real);
      });
    });
    const toggleRaw = root.querySelector('[data-toggle-raw]');
    if (toggleRaw) toggleRaw.addEventListener('click', () => { s.rawOpen = !s.rawOpen; this.render(); });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new Viewer(document.getElementById('app'));
});
