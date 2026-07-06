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

test('parses the current ChatGPT conversation branch instead of only visible DOM', () => {
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
        children: [],
        message: {
          id: 'msg-stale',
          author: { role: 'user' },
          content: { parts: ['Stale branch question'] },
          create_time: 3,
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

  assert.deepEqual(userTexts, ['First question', 'Current branch question']);
});
