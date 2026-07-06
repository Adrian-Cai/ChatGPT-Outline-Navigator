const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHooks() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const sandbox = {
    __TM_CHATGPT_OUTLINE_EXPOSE_TEST_HOOKS__: true,
    chrome: undefined,
    console,
    clearTimeout: () => {},
    setInterval: () => 0,
    setTimeout: () => 0,
    document: {
      querySelector: () => null,
      getElementById: () => null,
      body: {
        appendChild: () => {},
        contains: () => true,
      },
      documentElement: {
        contains: () => true,
      },
    },
    HTMLElement: function HTMLElement() {},
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
