(() => {
  'use strict';

  const STORAGE_KEY = 'chatgpt_outline_settings';

  const DEFAULT_CONFIG = {
    rootId: 'tm-chatgpt-outline-root',
    legacyRootId: 'tm-chatgpt-outline-root-v4',
    rootLayout: 'rail-card-v4',
    panelRight: 10,
    expandedWidth: 320,
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
    panelMaxHeight: '620px',
    clickLockMs: 650,
    activeScrollDelayMs: 180,
    defaultPinned: false,
    showRailLine: true,
    conversationFetchCooldownMs: 2500,
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
    conversationId: '',
    conversationItems: [],
    conversationFetchedAt: 0,
    conversationFetchPromise: null,
    domItemCache: new Map(),
    activeItems: [],
    pendingJumpId: null,
    cleanupTimer: null,
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
      expandedWidth: clampNumber(settings.expandedWidth, 300, 420, DEFAULT_CONFIG.expandedWidth),
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

  function hashText(text) {
    let hash = 0;
    const source = String(text || '');
    for (let i = 0; i < source.length; i += 1) {
      hash = (hash * 31 + source.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  function makeTextKey(role, text) {
    const clean = cleanText(text);
    return `${role}:${clean.length}:${hashText(clean)}`;
  }

  function normalizeContentPart(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.name === 'string') return part.name;
    if (typeof part.content === 'string') return part.content;
    try {
      return JSON.stringify(part);
    } catch (_) {
      return '';
    }
  }

  function extractTextFromMessageContent(content) {
    if (!content) return '';
    if (typeof content === 'string') return cleanText(content);

    const parts = Array.isArray(content.parts) ? content.parts : [];
    if (parts.length) {
      return cleanText(parts.map(normalizeContentPart).filter(Boolean).join(' '));
    }

    if (typeof content.text === 'string') return cleanText(content.text);
    if (typeof content.result === 'string') return cleanText(content.result);

    return '';
  }

  function normalizeUrlPath() {
    return `${location.pathname}${location.search}`;
  }

  function getConversationIdFromPath(pathname = location.pathname) {
    const match = String(pathname || '').match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function resetConversationStateIfNeeded(conversationId) {
    if (state.conversationId === conversationId) return;

    state.conversationId = conversationId;
    state.conversationItems = [];
    state.conversationFetchedAt = 0;
    state.conversationFetchPromise = null;
    state.domItemCache = new Map();
    state.activeItems = [];
    state.pendingJumpId = null;
  }

  function isSmallScreen() {
    return window.innerWidth < CONFIG.smallScreenWidth;
  }

  function nowLockedByClick() {
    return Date.now() < state.clickLockUntil;
  }

  function getOutlineRoots() {
    const roots = document.querySelectorAll(
      `#${CONFIG.rootId}, #${CONFIG.legacyRootId}, [id^="tm-chatgpt-outline-root"], [data-tm-outline-layout]`
    );

    return [...new Set([...roots])].filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
      return (
        node.id === CONFIG.rootId ||
        node.id === CONFIG.legacyRootId ||
        node.id.startsWith('tm-chatgpt-outline-root') ||
        Boolean(node.dataset?.tmOutlineLayout)
      );
    });
  }

  function getOutlineRootSelector() {
    return `#${CONFIG.rootId}, #${CONFIG.legacyRootId}, [id^="tm-chatgpt-outline-root"], [data-tm-outline-layout]`;
  }

  function isCurrentRoot(root) {
    return (
      root?.dataset?.tmOutlineLayout === CONFIG.rootLayout &&
      root.id === CONFIG.rootId &&
      root.querySelector('.tm-current-btn') &&
      root.querySelector('.tm-outline-rail')
    );
  }

  function getManagedRoot() {
    return getOutlineRoots().find(isCurrentRoot) || document.getElementById(CONFIG.rootId);
  }

  function removeStaleOutlineNodes(keepRoot = null) {
    getOutlineRoots().forEach((root) => {
      if (root !== keepRoot) root.remove();
    });

    document.querySelectorAll('.tm-outline-shell, .tm-outline-panel, .tm-outline-rail, .tm-outline-rail-stack, .tm-outline-tick').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const ownerRoot = node.closest(getOutlineRootSelector());
      if (ownerRoot !== keepRoot && node.parentElement) node.remove();
    });
  }

  function cleanupDuplicateRoots() {
    const roots = getOutlineRoots();
    if (roots.length <= 1 && roots.every(isCurrentRoot)) return;

    const keepRoot = roots.find(isCurrentRoot) || null;
    removeStaleOutlineNodes(keepRoot);
  }

  function setupRootCleanup() {
    if (state.cleanupTimer) clearInterval(state.cleanupTimer);
    cleanupDuplicateRoots();
    state.cleanupTimer = setInterval(cleanupDuplicateRoots, 600);
  }

  function createRoot() {
    const existingRoots = getOutlineRoots();
    const currentRoot = existingRoots.find(isCurrentRoot);
    if (currentRoot) {
      removeStaleOutlineNodes(currentRoot);
      return currentRoot;
    }
    removeStaleOutlineNodes();

    const root = document.createElement('div');
    root.id = CONFIG.rootId;
    root.dataset.tmOutlineLayout = CONFIG.rootLayout;
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
                <button class="tm-outline-btn tm-current-btn" type="button" aria-label="定位当前对话" title="定位当前对话">
                  <span class="tm-current-icon" aria-hidden="true"></span>
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

    root.querySelectorAll('.tm-pin-btn').forEach((pinBtn) => pinBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePin();
    }));

    const currentBtn = root.querySelector('.tm-current-btn');
    currentBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      locateCurrentInPanel();
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
    const root = getManagedRoot();
    if (!root) return;

    root.style.setProperty('--outline-panel-right', `${CONFIG.panelRight}px`);
    root.style.setProperty('--outline-expanded-width', `${CONFIG.expandedWidth}px`);
    root.style.setProperty('--outline-collapsed-width', `${CONFIG.collapsedWidth}px`);
    root.style.setProperty('--outline-tick-height', `${CONFIG.tickMapHeight}px`);
    root.style.setProperty('--outline-panel-max-height', CONFIG.panelMaxHeight);
    root.classList.toggle('no-rail-line', !CONFIG.showRailLine);
    root.classList.toggle('hidden-by-screen', CONFIG.autoHideOnSmallScreen && isSmallScreen());
    root.classList.toggle('expanded', state.isExpanded);
    root.classList.toggle('pinned', state.isPinned);
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
    const root = getManagedRoot();
    const pinButtons = root?.querySelectorAll('.tm-pin-btn') || [];
    pinButtons.forEach((pinBtn) => {
      pinBtn.classList.toggle('pinned', state.isPinned);
      pinBtn.title = state.isPinned ? '取消固定展开' : '固定展开';
      pinBtn.setAttribute('aria-label', pinBtn.title);
      pinBtn.setAttribute('aria-pressed', String(state.isPinned));
    });
  }

  function getConversationPathNodeIds(data) {
    const mapping = data?.mapping || {};
    const path = [];
    const seen = new Set();
    let currentId = data?.current_node;

    while (currentId && mapping[currentId] && !seen.has(currentId)) {
      seen.add(currentId);
      path.push(currentId);
      currentId = mapping[currentId].parent;
    }

    return path.reverse();
  }

  function getFallbackOrderedNodeIds(data) {
    const mapping = data?.mapping || {};
    return Object.values(mapping)
      .filter((node) => node?.message)
      .sort((a, b) => {
        const aTime = Number(a.message?.create_time || 0);
        const bTime = Number(b.message?.create_time || 0);
        return aTime - bTime;
      })
      .map((node) => node.id)
      .filter(Boolean);
  }

  function parseConversationResponse(data) {
    const mapping = data?.mapping || {};
    const nodeIds = getConversationPathNodeIds(data);
    const fallbackIds = getFallbackOrderedNodeIds(data);
    const orderedIds = fallbackIds.length ? fallbackIds : nodeIds;

    return orderedIds
      .map((nodeId, index) => {
        const node = mapping[nodeId];
        const message = node?.message;
        const role = message?.author?.role;
        if (role !== 'user' && role !== 'assistant') return null;

        const rawText = extractTextFromMessageContent(message.content);
        if (!rawText || rawText.length < 2) return null;

        const sourceId = message.id || node.id || nodeId;
        return {
          id: sourceId || `api-${index}`,
          sourceId,
          role,
          title: truncateText(rawText),
          rawText,
          element: null,
          position: index,
          fromApi: true,
        };
      })
      .filter(Boolean);
  }

  async function fetchConversationItems() {
    const conversationId = getConversationIdFromPath();
    resetConversationStateIfNeeded(conversationId);
    if (!conversationId) return [];

    const now = Date.now();
    if (state.conversationItems.length && now - state.conversationFetchedAt < CONFIG.conversationFetchCooldownMs) {
      return state.conversationItems;
    }

    if (state.conversationFetchPromise) {
      return state.conversationFetchPromise;
    }

    const url = `${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    state.conversationFetchPromise = fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
      },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`conversation fetch failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        state.conversationItems = parseConversationResponse(data);
        state.conversationFetchedAt = Date.now();
        return state.conversationItems;
      })
      .catch((error) => {
        logger.info('conversation fetch unavailable, using DOM fallback:', error);
        return state.conversationItems;
      })
      .finally(() => {
        state.conversationFetchPromise = null;
      });

    return state.conversationFetchPromise;
  }

  function getNodeSourceId(node) {
    return (
      node.getAttribute?.('data-message-id') ||
      node.getAttribute?.('data-testid') ||
      node.id ||
      ''
    );
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

  function buildDomItems() {
    const nodes = collectCandidateMessageNodes();
    const items = [];
    let fallbackRole = 'user';

    for (const node of nodes) {
      const text = cleanText(node.innerText || '');
      if (!text) continue;

      const role = guessRole(node, fallbackRole);
      fallbackRole = role === 'user' ? 'assistant' : 'user';

      const sourceId = getNodeSourceId(node);
      if (!node.dataset.tmOutlineId) node.dataset.tmOutlineId = sourceId || safeId(role);
      const rect = node.getBoundingClientRect();

      items.push({
        id: node.dataset.tmOutlineId,
        sourceId,
        role,
        title: truncateText(text),
        rawText: text,
        element: node,
        position: rect.top + window.scrollY,
        textKey: makeTextKey(role, text),
        fromApi: false,
      });
    }

    return items;
  }

  function isConnectedElement(element) {
    return Boolean(element && (document.body?.contains?.(element) || document.documentElement?.contains?.(element)));
  }

  function rememberDomItems(domItems) {
    domItems.forEach((item) => {
      if (!item.textKey) return;
      const previous = state.domItemCache.get(item.textKey) || {};
      state.domItemCache.set(item.textKey, {
        ...previous,
        ...item,
        firstSeenAt: previous.firstSeenAt || Date.now(),
        lastSeenAt: Date.now(),
      });
    });
  }

  function getCachedDomItems() {
    return [...state.domItemCache.values()].sort((a, b) => {
      const aPosition = Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
      const bPosition = Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
      if (aPosition !== bPosition) return aPosition - bPosition;
      return (a.firstSeenAt || 0) - (b.firstSeenAt || 0);
    });
  }

  function isSameMessageText(a, b) {
    const left = cleanText(a);
    const right = cleanText(b);
    return left === right || left.startsWith(right) || right.startsWith(left);
  }

  function attachDomElements(conversationItems, domItems) {
    const used = new Set();

    return conversationItems.map((item) => {
      const exactIndex = domItems.findIndex((candidate, index) => {
        if (used.has(index)) return false;
        return item.sourceId && candidate.sourceId && item.sourceId === candidate.sourceId;
      });

      const textIndex =
        exactIndex >= 0
          ? exactIndex
          : domItems.findIndex((candidate, index) => {
              if (used.has(index)) return false;
              return candidate.role === item.role && isSameMessageText(candidate.rawText, item.rawText);
            });

      if (textIndex < 0) return { ...item, textKey: makeTextKey(item.role, item.rawText) };

      used.add(textIndex);
      const domItem = domItems[textIndex];
      if (domItem.element) domItem.element.dataset.tmOutlineId = item.id;
      return {
        ...item,
        element: domItem.element,
        position: domItem.position,
        textKey: domItem.textKey,
      };
    });
  }

  async function buildAllItems() {
    const domItems = buildDomItems();
    rememberDomItems(domItems);

    const conversationItems = await fetchConversationItems();
    let baseItems = getCachedDomItems();
    if (conversationItems.length) {
      const attachedItems = attachDomElements(conversationItems, domItems);
      const attachedKeys = new Set(attachedItems.map((item) => item.sourceId || item.textKey || item.id));
      const freshDomItems = domItems.filter((item) => !attachedKeys.has(item.sourceId || item.textKey || item.id));
      baseItems = [...attachedItems, ...freshDomItems];
    }
    state.activeItems = baseItems;
    const filteredItems = CONFIG.onlyUserMessages ? baseItems.filter((item) => item.role === 'user') : baseItems;
    const seen = new Set();

    return filteredItems.filter((item) => {
      const key = item.sourceId || item.textKey || item.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

  function getNavigationSourceItems() {
    return state.activeItems.length ? state.activeItems : state.allItems;
  }

  function getCurrentNavigationItem() {
    const sourceItems = getNavigationSourceItems();
    if (!sourceItems.length || !state.activeId) return null;

    return (
      sourceItems.find((item) => item.id === state.activeId) ||
      state.allItems.find((item) => item.id === state.activeId) ||
      null
    );
  }

  function getRailMapY(index, count) {
    if (!count) return null;
    if (count === 1) return Math.round(CONFIG.tickMapHeight / 2);

    const topPadding = 8;
    const bottomPadding = 8;
    const usableHeight = CONFIG.tickMapHeight - topPadding - bottomPadding;
    return Math.round(topPadding + (usableHeight / (count - 1)) * index);
  }

  function buildTickItems(outlineItems) {
    const count = outlineItems.length;
    if (!count) return [];

    return outlineItems.map((item, index) => ({
      ...item,
      mapY: getRailMapY(index, count),
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
    const sourceItems = getNavigationSourceItems();
    const highlightedId = mapActiveIdToNearestOutlineId(state.activeId, state.outlineItems, sourceItems);
    const tickKey = JSON.stringify({
      ids: tickItems.map((item) => [item.id, item.mapY]),
      active: highlightedId,
      height: CONFIG.tickMapHeight,
    });

    if (!force && tickKey === state.lastRenderedTickKey) return;
    state.lastRenderedTickKey = tickKey;
    rail.innerHTML = '';
    updateCurrentButton();

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

    const highlightedId = mapActiveIdToNearestOutlineId(state.activeId, state.outlineItems, getNavigationSourceItems());
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

  function updateCurrentButton() {
    const root = getManagedRoot();
    const currentBtn = root?.querySelector('.tm-current-btn');
    if (!currentBtn) return;

    const currentItem = getCurrentNavigationItem();
    currentBtn.disabled = !currentItem;
    currentBtn.title = currentItem ? `定位当前对话：${currentItem.title}` : '暂无当前对话';
    currentBtn.setAttribute('aria-label', currentBtn.title);
  }

  function locateCurrentInPanel() {
    if (!state.activeId) return;

    clearTimeout(state.collapseTimer);
    clearTimeout(state.expandTimer);
    state.isExpanded = true;
    applyVisualSettings();
    renderPanelItems();
    renderTicks(true);
    setTimeout(() => ensureActiveItemVisible(), 40);
  }

  function scheduleEnsureActiveVisible() {
    clearTimeout(state.activeScrollTimer);
    state.activeScrollTimer = setTimeout(() => {
      ensureActiveItemVisible();
    }, CONFIG.activeScrollDelayMs);
  }

  function ensureActiveItemVisible() {
    const root = getManagedRoot();
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

  function getEstimatedScrollTopForItem(id) {
    const index = state.allItems.findIndex((candidate) => candidate.id === id);
    if (index < 0) return null;

    const maxScroll = Math.max(
      0,
      (document.documentElement?.scrollHeight || document.body?.scrollHeight || 0) - window.innerHeight
    );
    if (!maxScroll) return 0;
    if (state.allItems.length <= 1) return maxScroll / 2;

    return Math.round((index / (state.allItems.length - 1)) * maxScroll);
  }

  function scrollToEstimatedItem(id) {
    const top = getEstimatedScrollTopForItem(id);
    if (top === null) return;

    state.pendingJumpId = id;
    window.scrollTo({
      top,
      behavior: 'smooth',
    });
    setTimeout(() => refreshOutline('pending jump'), 700);
    setTimeout(() => refreshOutline('pending jump settle'), 1500);
  }

  function completePendingJump() {
    if (!state.pendingJumpId) return;

    const item = state.allItems.find((candidate) => candidate.id === state.pendingJumpId);
    if (!isConnectedElement(item?.element)) return;

    state.pendingJumpId = null;
    item.element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    flashTarget(item.element);
  }

  function jumpToMessage(id) {
    const item = state.allItems.find((candidate) => candidate.id === id);
    if (!item) return;

    state.clickLockUntil = Date.now() + CONFIG.clickLockMs;
    state.activeId = id;

    renderTicks(true);
    renderPanelItems();

    if (!isConnectedElement(item.element)) {
      scrollToEstimatedItem(id);
      return;
    }

    item.element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });

    flashTarget(item.element);
  }

  function getViewportItemScore(item) {
    if (!isConnectedElement(item?.element)) return -Infinity;

    const rect = item.element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    if (!viewportHeight || rect.height <= 0) return -Infinity;

    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(viewportHeight, rect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    if (!visibleHeight) return -Infinity;

    const visibleRatio = visibleHeight / rect.height;
    const viewportCenter = viewportHeight / 2;
    const elementCenter = rect.top + rect.height / 2;
    return visibleRatio * 1000 - Math.abs(elementCenter - viewportCenter);
  }

  function pickBestViewportItemId(items = state.allItems) {
    let bestId = null;
    let bestScore = -Infinity;

    items.forEach((item) => {
      const score = getViewportItemScore(item);
      if (score > bestScore) {
        bestScore = score;
        bestId = item.id;
      }
    });

    return bestId;
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
      if (isConnectedElement(item.element)) state.intersectionObserver.observe(item.element);
    });
  }

  async function refreshOutline(reason = 'unknown') {
    logger.info('refresh:', reason);

    try {
      const oldActiveId = state.activeId;
      state.allItems = await buildAllItems();
      state.outlineItems = buildFixedOutlineItems(state.allItems);
      const visibleActiveId = pickBestViewportItemId(state.activeItems);

      if (!state.allItems.length) {
        state.activeId = null;
      } else if (visibleActiveId) {
        state.activeId = visibleActiveId;
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
      completePendingJump();
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
        if (mutation.target instanceof Element && mutation.target.closest(getOutlineRootSelector())) {
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
    setupRootCleanup();
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

  if (typeof globalThis !== 'undefined' && globalThis.__TM_CHATGPT_OUTLINE_EXPOSE_TEST_HOOKS__) {
    globalThis.__TM_CHATGPT_OUTLINE_TEST_HOOKS__ = {
      extractTextFromMessageContent,
      getConversationIdFromPath,
      getConversationPathNodeIds,
      cleanupDuplicateRoots,
      getOutlineRoots,
      mapActiveIdToNearestOutlineId,
      pickBestViewportItemId,
      parseConversationResponse,
      removeStaleOutlineNodes,
    };
  }

  waitForReady();
})();
