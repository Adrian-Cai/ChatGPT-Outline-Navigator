(() => {
  'use strict';

  const STORAGE_KEY = 'chatgpt_outline_settings';

  const DEFAULT_CONFIG = {
    rootId: 'tm-chatgpt-outline-root',
    panelRight: 10,
    expandedWidth: 240,
    collapsedWidth: 18,
    maxOutlineItems: 10,
    tickMapHeight: 320,
    hoverExpandDelay: 70,
    hoverCollapseDelay: 220,
    refreshDebounceMs: 280,
    outlineTitleMaxLen: 64,
    highlightClass: 'tm-chatgpt-outline-target-highlight',
    debug: false,
    onlyUserMessages: true,
    smallScreenWidth: 1100,
    autoHideOnSmallScreen: true,
    panelMaxHeight: '150px',
    clickLockMs: 650,
    activeScrollDelayMs: 180,
    defaultPinned: false,
    showRailLine: true,
  };

  const CONFIG = { ...DEFAULT_CONFIG };

  const state = {
    allItems: [],
    outlineItems: [],
    activeId: null,
    observer: null,
    intersectionObserver: null,
    initialized: false,
    isExpanded: false,
    isPinned: false,
    pinInitialized: false,
    expandTimer: null,
    collapseTimer: null,
    lastUrl: '',
    clickLockUntil: 0,
    activeScrollTimer: null,
    lastRenderedTickKey: '',
    visibleMap: new Map(),
  };

  const logger = {
    info: (...args) => CONFIG.debug && console.log('[Outline]', ...args),
    error: (...args) => console.error('[Outline]', ...args),
  };

  function getChromeStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    return chrome.storage;
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function throttle(fn, wait) {
    let last = 0;
    let timer = null;
    return function throttled(...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function sanitizeSettings(settings = {}) {
    return {
      maxOutlineItems: clampNumber(settings.maxOutlineItems, 5, 20, DEFAULT_CONFIG.maxOutlineItems),
      onlyUserMessages: Boolean(settings.onlyUserMessages ?? DEFAULT_CONFIG.onlyUserMessages),
      panelRight: clampNumber(settings.panelRight, 0, 48, DEFAULT_CONFIG.panelRight),
      expandedWidth: clampNumber(settings.expandedWidth, 200, 360, DEFAULT_CONFIG.expandedWidth),
      tickMapHeight: clampNumber(settings.tickMapHeight, 220, 500, DEFAULT_CONFIG.tickMapHeight),
      autoHideOnSmallScreen: Boolean(settings.autoHideOnSmallScreen ?? DEFAULT_CONFIG.autoHideOnSmallScreen),
      defaultPinned: Boolean(settings.defaultPinned ?? DEFAULT_CONFIG.defaultPinned),
      showRailLine: Boolean(settings.showRailLine ?? DEFAULT_CONFIG.showRailLine),
    };
  }

  async function loadUserSettings() {
    try {
      const storage = getChromeStorage();
      if (!storage?.sync) return;
      const result = await storage.sync.get(STORAGE_KEY);
      Object.assign(CONFIG, sanitizeSettings(result[STORAGE_KEY] || {}));
    } catch (error) {
      logger.error('load settings failed:', error);
    }
  }

  function setupStorageWatcher() {
    const storage = getChromeStorage();
    if (!storage?.onChanged) return;
    storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[STORAGE_KEY]) return;
      const nextSettings = sanitizeSettings(changes[STORAGE_KEY].newValue || {});
      const pinChanged = nextSettings.defaultPinned !== CONFIG.defaultPinned;
      Object.assign(CONFIG, nextSettings);
      if (pinChanged) {
        state.isPinned = CONFIG.defaultPinned;
        state.isExpanded = CONFIG.defaultPinned;
      }
      applyVisualSettings();
      refreshOutline('settings changed');
    });
  }

  function cleanText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function truncateText(text, maxLen = CONFIG.outlineTitleMaxLen) {
    if (!text) return '（空消息）';
    return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
  }

  function safeId(prefix = 'msg') {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function normalizeUrlPath() {
    return `${location.pathname}${location.search}`;
  }

  function isSmallScreen() {
    return window.innerWidth < CONFIG.smallScreenWidth;
  }

  function nowLockedByClick() {
    return Date.now() < state.clickLockUntil;
  }

  function createRoot() {
    let root = document.getElementById(CONFIG.rootId);
    if (root) return root;

    root = document.createElement('div');
    root.id = CONFIG.rootId;
    root.innerHTML = `
      <div class="tm-outline-shell">
        <div class="tm-outline-panel">
          <div class="tm-outline-panel-inner">
            <div class="tm-outline-header">
              <div class="tm-outline-title">对话大纲</div>
              <div class="tm-outline-header-right">
                <button class="tm-outline-btn tm-pin-btn" type="button" aria-label="固定展开" title="固定展开">
                  <span class="tm-pin-icon" aria-hidden="true"></span>
                </button>
              </div>
            </div>
            <div class="tm-outline-body" aria-label="对话大纲列表">
              <div class="tm-outline-empty" role="status">正在扫描当前对话...</div>
            </div>
          </div>
        </div>
        <div class="tm-outline-rail" aria-label="对话刻度导航"></div>
      </div>
    `;

    document.body.appendChild(root);

    root.addEventListener('mouseenter', () => {
      if (!state.isPinned) expandPanel();
    });

    root.addEventListener('mouseleave', () => {
      if (!state.isPinned) collapsePanel();
    });

    const pinBtn = root.querySelector('.tm-pin-btn');
    pinBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePin();
    });

    window.addEventListener(
      'resize',
      debounce(() => {
        applyVisualSettings();
        refreshOutline('resize');
      }, 140)
    );

    applyVisualSettings();
    updatePinButton();
    return root;
  }

  function applyVisualSettings() {
    const root = document.getElementById(CONFIG.rootId);
    if (!root) return;

    root.style.setProperty('--outline-panel-right', `${CONFIG.panelRight}px`);
    root.style.setProperty('--outline-expanded-width', `${CONFIG.expandedWidth}px`);
    root.style.setProperty('--outline-collapsed-width', `${CONFIG.collapsedWidth}px`);
    root.style.setProperty('--outline-tick-height', `${CONFIG.tickMapHeight}px`);
    root.style.setProperty('--outline-panel-max-height', CONFIG.panelMaxHeight);
    root.classList.toggle('no-rail-line', !CONFIG.showRailLine);
    root.classList.toggle('hidden-by-screen', CONFIG.autoHideOnSmallScreen && isSmallScreen());
    root.classList.toggle('expanded', state.isExpanded);
  }

  function expandPanel() {
    clearTimeout(state.collapseTimer);
    clearTimeout(state.expandTimer);
    state.expandTimer = setTimeout(() => {
      state.isExpanded = true;
      applyVisualSettings();
    }, CONFIG.hoverExpandDelay);
  }

  function collapsePanel() {
    clearTimeout(state.expandTimer);
    clearTimeout(state.collapseTimer);
    state.collapseTimer = setTimeout(() => {
      if (state.isPinned) return;
      state.isExpanded = false;
      applyVisualSettings();
    }, CONFIG.hoverCollapseDelay);
  }

  function togglePin() {
    state.isPinned = !state.isPinned;
    state.isExpanded = state.isPinned;
    updatePinButton();
    applyVisualSettings();
  }

  function updatePinButton() {
    const root = document.getElementById(CONFIG.rootId);
    const pinBtn = root?.querySelector('.tm-pin-btn');
    if (!pinBtn) return;
    pinBtn.classList.toggle('pinned', state.isPinned);
    pinBtn.title = state.isPinned ? '取消固定展开' : '固定展开';
    pinBtn.setAttribute('aria-label', pinBtn.title);
  }

  function collectCandidateMessageNodes() {
    const result = [];
    const seen = new Set();
    const selectors = [
      '[data-message-author-role]',
      'main [data-message-author-role]',
      'main article',
      'article',
    ];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (!isVisible(node)) return;
        const text = cleanText(node.innerText || '');
        if (!text || text.length < 2) return;
        if (seen.has(node)) return;
        seen.add(node);
        result.push(node);
      });
    }

    return result;
  }

  function guessRole(node, fallbackRole = 'user') {
    const own = node.getAttribute?.('data-message-author-role');
    if (own === 'user' || own === 'assistant') return own;

    const parent = node.closest('[data-message-author-role]');
    const parentRole = parent?.getAttribute?.('data-message-author-role');
    if (parentRole === 'user' || parentRole === 'assistant') return parentRole;

    return fallbackRole;
  }

  function buildAllItems() {
    const nodes = collectCandidateMessageNodes();
    const items = [];
    let fallbackRole = 'user';

    for (const node of nodes) {
      const text = cleanText(node.innerText || '');
      if (!text) continue;

      const role = guessRole(node, fallbackRole);
      fallbackRole = role === 'user' ? 'assistant' : 'user';

      if (CONFIG.onlyUserMessages && role !== 'user') continue;

      if (!node.dataset.tmOutlineId) {
        node.dataset.tmOutlineId = safeId(role);
      }

      items.push({
        id: node.dataset.tmOutlineId,
        role,
        title: truncateText(text),
        rawText: text,
        element: node,
      });
    }

    return items;
  }

  function buildFixedOutlineItems(allItems) {
    if (allItems.length <= CONFIG.maxOutlineItems) return [...allItems];

    const result = [];
    const lastIndex = allItems.length - 1;

    for (let i = 0; i < CONFIG.maxOutlineItems; i += 1) {
      const idx = Math.round((i * lastIndex) / (CONFIG.maxOutlineItems - 1));
      result.push(allItems[idx]);
    }

    return result.filter((item, index, arr) => index === arr.findIndex((candidate) => candidate.id === item.id));
  }

  function buildTickItems(outlineItems) {
    const count = outlineItems.length;
    if (!count) return [];

    if (count === 1) {
      return [{ ...outlineItems[0], mapY: Math.round(CONFIG.tickMapHeight / 2) }];
    }

    const topPadding = 8;
    const bottomPadding = 8;
    const usableHeight = CONFIG.tickMapHeight - topPadding - bottomPadding;
    const step = usableHeight / (count - 1);

    return outlineItems.map((item, index) => ({
      ...item,
      mapY: Math.round(topPadding + step * index),
    }));
  }

  function mapActiveIdToNearestOutlineId(activeId, outlineItems, allItems) {
    if (!activeId || !outlineItems.length) return null;
    if (outlineItems.some((item) => item.id === activeId)) return activeId;

    const activeIndex = allItems.findIndex((item) => item.id === activeId);
    if (activeIndex < 0) return outlineItems[0]?.id || null;

    let bestId = outlineItems[0].id;
    let bestDistance = Infinity;

    outlineItems.forEach((item) => {
      const idx = allItems.findIndex((candidate) => candidate.id === item.id);
      if (idx < 0) return;
      const distance = Math.abs(idx - activeIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = item.id;
      }
    });

    return bestId;
  }

  function renderTicks(force = false) {
    const root = createRoot();
    const rail = root.querySelector('.tm-outline-rail');
    if (!rail) return;

    const tickItems = buildTickItems(state.outlineItems);
    const highlightedId = mapActiveIdToNearestOutlineId(state.activeId, state.outlineItems, state.allItems);
    const tickKey = JSON.stringify({
      ids: tickItems.map((item) => [item.id, item.mapY]),
      active: highlightedId,
      height: CONFIG.tickMapHeight,
    });

    if (!force && tickKey === state.lastRenderedTickKey) return;
    state.lastRenderedTickKey = tickKey;
    rail.innerHTML = '';

    if (!tickItems.length) {
      const empty = document.createElement('button');
      empty.type = 'button';
      empty.className = 'tm-outline-tick';
      empty.style.top = `${Math.round(CONFIG.tickMapHeight / 2)}px`;
      empty.title = '没有可导航的消息';
      empty.setAttribute('aria-label', empty.title);
      rail.appendChild(empty);
      return;
    }

    tickItems.forEach((item) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'tm-outline-tick';
      if (item.id === highlightedId) tick.classList.add('active');
      tick.title = item.title;
      tick.setAttribute('aria-label', `跳转到：${item.title}`);
      tick.style.top = `${item.mapY}px`;
      tick.addEventListener('click', (event) => {
        event.stopPropagation();
        jumpToMessage(item.id);
      });
      rail.appendChild(tick);
    });
  }

  function renderPanelItems() {
    const root = createRoot();
    const body = root.querySelector('.tm-outline-body');
    const title = root.querySelector('.tm-outline-title');
    if (!body) return;

    if (title) {
      title.textContent = state.outlineItems.length ? `对话大纲 · ${state.outlineItems.length}` : '对话大纲';
    }

    if (!state.outlineItems.length) {
      body.innerHTML = '<div class="tm-outline-empty" role="status">没有可导航的消息</div>';
      return;
    }

    const highlightedId = mapActiveIdToNearestOutlineId(state.activeId, state.outlineItems, state.allItems);
    body.innerHTML = '';

    state.outlineItems.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tm-outline-item';
      btn.title = item.rawText;
      btn.setAttribute('aria-label', `跳转到：${item.title}`);
      if (item.id === highlightedId) {
        btn.classList.add('active');
        btn.setAttribute('aria-current', 'true');
      }
      btn.innerHTML = `
        <span class="tm-outline-item-title">${escapeHtml(item.title)}</span>
        <span class="tm-outline-item-marker" aria-hidden="true"><span></span></span>
      `;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        jumpToMessage(item.id);
      });
      body.appendChild(btn);
    });

    scheduleEnsureActiveVisible();
  }

  function scheduleEnsureActiveVisible() {
    clearTimeout(state.activeScrollTimer);
    state.activeScrollTimer = setTimeout(() => {
      ensureActiveItemVisible();
    }, CONFIG.activeScrollDelayMs);
  }

  function ensureActiveItemVisible() {
    const root = document.getElementById(CONFIG.rootId);
    const body = root?.querySelector('.tm-outline-body');
    const active = root?.querySelector('.tm-outline-item.active');
    if (!body || !active) return;

    const bodyRect = body.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const overTop = activeRect.top < bodyRect.top + 12;
    const overBottom = activeRect.bottom > bodyRect.bottom - 12;

    if (overTop || overBottom) {
      active.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }

  function flashTarget(el) {
    if (!el) return;
    el.classList.add(CONFIG.highlightClass);
    setTimeout(() => el.classList.remove(CONFIG.highlightClass), 1400);
  }

  function jumpToMessage(id) {
    const item = state.allItems.find((candidate) => candidate.id === id);
    if (!item?.element) return;

    state.clickLockUntil = Date.now() + CONFIG.clickLockMs;
    state.activeId = id;

    renderTicks(true);
    renderPanelItems();

    item.element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });

    flashTarget(item.element);
  }

  function pickBestVisibleId(entriesVisibleMap) {
    let bestId = null;
    let bestScore = -Infinity;

    entriesVisibleMap.forEach((meta, id) => {
      const ratioScore = meta.ratio * 1000;
      const centerPenalty = Math.abs(meta.centerOffset);
      const score = ratioScore - centerPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    });

    return bestId;
  }

  function setupIntersectionObserver() {
    if (state.intersectionObserver) {
      state.intersectionObserver.disconnect();
    }

    state.visibleMap = new Map();
    state.intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (nowLockedByClick()) return;

        const viewportCenter = window.innerHeight / 2;
        entries.forEach((entry) => {
          const id = entry.target.dataset.tmOutlineId;
          if (!id) return;

          if (entry.isIntersecting) {
            const rect = entry.boundingClientRect;
            const elementCenter = rect.top + rect.height / 2;
            state.visibleMap.set(id, {
              ratio: entry.intersectionRatio,
              centerOffset: elementCenter - viewportCenter,
            });
          } else {
            state.visibleMap.delete(id);
          }
        });

        const bestId = pickBestVisibleId(state.visibleMap);
        if (bestId && bestId !== state.activeId) {
          state.activeId = bestId;
          renderTicks();
          renderPanelItems();
        }
      },
      {
        root: null,
        rootMargin: '-10% 0px -18% 0px',
        threshold: [0.08, 0.15, 0.25, 0.4, 0.6, 0.8],
      }
    );

    state.allItems.forEach((item) => {
      if (item.element) state.intersectionObserver.observe(item.element);
    });
  }

  function refreshOutline(reason = 'unknown') {
    logger.info('refresh:', reason);

    try {
      const oldActiveId = state.activeId;
      state.allItems = buildAllItems();
      state.outlineItems = buildFixedOutlineItems(state.allItems);

      if (!state.allItems.length) {
        state.activeId = null;
      } else if (oldActiveId && state.allItems.some((item) => item.id === oldActiveId)) {
        state.activeId = oldActiveId;
      } else {
        state.activeId = state.allItems[0].id;
      }

      state.lastRenderedTickKey = '';
      applyVisualSettings();
      renderTicks(true);
      renderPanelItems();
      setupIntersectionObserver();
      updatePinButton();
    } catch (err) {
      logger.error('refresh failed:', err);
    }
  }

  const scheduleRefresh = debounce((reason) => refreshOutline(reason), CONFIG.refreshDebounceMs);

  function setupMutationObserver() {
    if (state.observer) {
      state.observer.disconnect();
    }

    state.observer = new MutationObserver((mutations) => {
      if (nowLockedByClick()) return;

      for (const mutation of mutations) {
        if (mutation.target instanceof Element && mutation.target.closest(`#${CONFIG.rootId}`)) {
          continue;
        }
        if (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          scheduleRefresh('dom mutation');
          return;
        }
      }
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function setupUrlWatcher() {
    state.lastUrl = normalizeUrlPath();

    setInterval(() => {
      const current = normalizeUrlPath();
      if (current !== state.lastUrl) {
        state.lastUrl = current;
        setTimeout(() => refreshOutline('url changed'), 450);
      }
    }, 800);
  }

  function setupScrollListener() {
    window.addEventListener(
      'scroll',
      throttle(() => {
        if (nowLockedByClick()) return;
        renderTicks(true);
      }, 180),
      { passive: true }
    );
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;

    await loadUserSettings();
    state.isPinned = CONFIG.defaultPinned;
    state.isExpanded = CONFIG.defaultPinned;
    state.pinInitialized = true;

    createRoot();
    setupStorageWatcher();
    setupMutationObserver();
    setupUrlWatcher();
    setupScrollListener();
    refreshOutline('init');

    setTimeout(() => refreshOutline('post-init 1'), 900);
    setTimeout(() => refreshOutline('post-init 2'), 1800);
    setTimeout(() => refreshOutline('post-init 3'), 3000);
  }

  function waitForReady(retries = 40) {
    if (document.querySelector('main') || retries <= 0) {
      init();
      return;
    }
    setTimeout(() => waitForReady(retries - 1), 500);
  }

  waitForReady();
})();
