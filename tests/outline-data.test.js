const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHooks(overrides = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const defaultDocument = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: {
      appendChild: () => {},
      contains: () => true,
    },
    documentElement: {
      contains: () => true,
    },
  };
  const HTMLElementImpl = overrides.HTMLElement || function HTMLElement() {};
  const sandbox = {
    __TM_CHATGPT_OUTLINE_EXPOSE_TEST_HOOKS__: true,
    chrome: undefined,
    console,
    clearTimeout: () => {},
    setInterval: () => 0,
    setTimeout: () => 0,
    document: overrides.document || defaultDocument,
    Element: overrides.Element || HTMLElementImpl,
    HTMLElement: HTMLElementImpl,
    IntersectionObserver: function IntersectionObserver() {},
    location: {
      pathname: '/c/thread-1',
      search: '',
      origin: 'https://chatgpt.com',
    },
    MutationObserver: function MutationObserver() {},
    window: {
      addEventListener: () => {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      innerHeight: 900,
      innerWidth: 1440,
      scrollTo: () => {},
      scrollY: 0,
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'content.js' });
  return sandbox.__TM_CHATGPT_OUTLINE_TEST_HOOKS__;
}

class FakeElement {
  constructor({ id = '', classNames = [], dataset = {} } = {}) {
    this.id = id;
    this.dataset = dataset;
    this.classNames = new Set(classNames);
    this.children = [];
    this.parentElement = null;
    this.removed = false;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    this.removed = true;
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const trimmed = part.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('#')) return this.id === trimmed.slice(1);
      if (trimmed === '[id^="tm-chatgpt-outline-root"]') {
        return this.id.startsWith('tm-chatgpt-outline-root');
      }
      if (trimmed === '[data-tm-outline-layout]') {
        return Boolean(this.dataset.tmOutlineLayout);
      }
      if (trimmed.startsWith('.')) return this.classNames.has(trimmed.slice(1));
      return false;
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (!node.removed && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (node.removed) return;
      if (node !== this && node.matches(selector)) matches.push(node);
      node.children.forEach(visit);
    };
    visit(this);
    return matches;
  }
}

function createFakeDocument() {
  const body = new FakeElement();
  return {
    body,
    documentElement: body,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    getElementById: (id) => body.querySelector(`#${id}`),
  };
}

test('parses all available ChatGPT conversation user messages for navigation titles', () => {
  const hooks = loadHooks();

  const items = hooks.parseConversationResponse({
    current_node: 'current-user',
    mapping: {
      root: { id: 'root', parent: null, children: ['first-user'], message: null },
      'first-user': {
        id: 'first-user',
        parent: 'root',
        children: ['assistant-1', 'stale-sibling'],
        message: {
          id: 'msg-user-1',
          author: { role: 'user' },
          content: { parts: ['First question'] },
          create_time: 1,
        },
      },
      'assistant-1': {
        id: 'assistant-1',
        parent: 'first-user',
        children: ['current-user'],
        message: {
          id: 'msg-assistant-1',
          author: { role: 'assistant' },
          content: { parts: ['Answer'] },
          create_time: 2,
        },
      },
      'stale-sibling': {
        id: 'stale-sibling',
        parent: 'first-user',
        children: ['fourth-user'],
        message: {
          id: 'msg-stale',
          author: { role: 'user' },
          content: { parts: ['Stale branch question'] },
          create_time: 3,
        },
      },
      'fourth-user': {
        id: 'fourth-user',
        parent: 'stale-sibling',
        children: [],
        message: {
          id: 'msg-user-4',
          author: { role: 'user' },
          content: { parts: ['Fourth visible question'] },
          create_time: 5,
        },
      },
      'current-user': {
        id: 'current-user',
        parent: 'assistant-1',
        children: [],
        message: {
          id: 'msg-user-2',
          author: { role: 'user' },
          content: { parts: ['Current branch question'] },
          create_time: 4,
        },
      },
    },
  });

  const userTexts = Array.from(
    items.filter((item) => item.role === 'user').map((item) => item.rawText)
  );

  assert.deepEqual(userTexts, [
    'First question',
    'Stale branch question',
    'Current branch question',
    'Fourth visible question',
  ]);
});

test('picks the visible item nearest the viewport center as active', () => {
  const hooks = loadHooks();
  const makeElement = (top, bottom) => ({
    getBoundingClientRect: () => ({
      top,
      bottom,
      height: bottom - top,
    }),
  });

  const activeId = hooks.pickBestViewportItemId([
    { id: 'first', element: makeElement(-500, -100) },
    { id: 'last', element: makeElement(280, 720) },
  ]);

  assert.equal(activeId, 'last');
});

test('maps a visible assistant response back to the nearest user navigation item', () => {
  const hooks = loadHooks();

  const mappedId = hooks.mapActiveIdToNearestOutlineId(
    'assistant-last',
    [{ id: 'user-first' }, { id: 'user-last' }],
    [
      { id: 'user-first' },
      { id: 'assistant-first' },
      { id: 'user-last' },
      { id: 'assistant-last' },
    ]
  );

  assert.equal(mappedId, 'user-last');
});

test('cleans v4 outline rails while keeping the preferred rail', () => {
  const document = createFakeDocument();
  const currentRoot = new FakeElement({
    id: 'tm-chatgpt-outline-root',
    dataset: { tmOutlineLayout: 'rail-card-v4' },
  });
  const currentButton = new FakeElement({ classNames: ['tm-current-btn'] });
  const currentRail = new FakeElement({ classNames: ['tm-outline-rail'] });
  const currentTick = new FakeElement({ classNames: ['tm-outline-tick'] });
  const staleRoot = new FakeElement({
    id: 'tm-chatgpt-outline-root-v4',
    dataset: { tmOutlineLayout: 'rail-card-v4' },
  });
  const staleRail = new FakeElement({ classNames: ['tm-outline-rail'] });
  const orphanRail = new FakeElement({ classNames: ['tm-outline-rail'] });
  const orphanTick = new FakeElement({ classNames: ['tm-outline-tick'] });

  currentRail.appendChild(currentTick);
  currentRoot.appendChild(currentButton);
  currentRoot.appendChild(currentRail);
  staleRoot.appendChild(staleRail);
  document.body.appendChild(currentRoot);
  document.body.appendChild(staleRoot);
  document.body.appendChild(orphanRail);
  document.body.appendChild(orphanTick);

  const hooks = loadHooks({ document, Element: FakeElement, HTMLElement: FakeElement });

  assert.equal(hooks.getOutlineRoots().length, 2);

  hooks.cleanupDuplicateRoots();

  assert.equal(currentRoot.removed, false);
  assert.equal(currentRail.removed, false);
  assert.equal(currentTick.removed, false);
  assert.equal(staleRoot.removed, true);
  assert.equal(staleRail.removed, false);
  assert.equal(orphanRail.removed, true);
  assert.equal(orphanTick.removed, true);
});
