const DEFAULT_SETTINGS = {
  maxOutlineItems: 10,
  onlyUserMessages: true,
  panelRight: 10,
  expandedWidth: 320,
  tickMapHeight: 320,
  autoHideOnSmallScreen: true,
  defaultPinned: false,
  showRailLine: true,
};

const STORAGE_KEY = 'chatgpt_outline_settings';

const form = document.getElementById('settingsForm');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('statusText');

const fields = {
  maxOutlineItems: document.getElementById('maxOutlineItems'),
  onlyUserMessages: document.getElementById('onlyUserMessages'),
  panelRight: document.getElementById('panelRight'),
  expandedWidth: document.getElementById('expandedWidth'),
  tickMapHeight: document.getElementById('tickMapHeight'),
  autoHideOnSmallScreen: document.getElementById('autoHideOnSmallScreen'),
  defaultPinned: document.getElementById('defaultPinned'),
  showRailLine: document.getElementById('showRailLine'),
};

function setStatus(text) {
  statusText.textContent = text;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeSettings(settings = {}) {
  return {
    maxOutlineItems: clampNumber(settings.maxOutlineItems, 5, 20, DEFAULT_SETTINGS.maxOutlineItems),
    onlyUserMessages: Boolean(settings.onlyUserMessages ?? DEFAULT_SETTINGS.onlyUserMessages),
    panelRight: clampNumber(settings.panelRight, 0, 48, DEFAULT_SETTINGS.panelRight),
    expandedWidth: clampNumber(settings.expandedWidth, 300, 420, DEFAULT_SETTINGS.expandedWidth),
    tickMapHeight: clampNumber(settings.tickMapHeight, 220, 500, DEFAULT_SETTINGS.tickMapHeight),
    autoHideOnSmallScreen: Boolean(settings.autoHideOnSmallScreen ?? DEFAULT_SETTINGS.autoHideOnSmallScreen),
    defaultPinned: Boolean(settings.defaultPinned ?? DEFAULT_SETTINGS.defaultPinned),
    showRailLine: Boolean(settings.showRailLine ?? DEFAULT_SETTINGS.showRailLine),
  };
}

function readForm() {
  return normalizeSettings({
    maxOutlineItems: fields.maxOutlineItems.value,
    onlyUserMessages: fields.onlyUserMessages.checked,
    panelRight: fields.panelRight.value,
    expandedWidth: fields.expandedWidth.value,
    tickMapHeight: fields.tickMapHeight.value,
    autoHideOnSmallScreen: fields.autoHideOnSmallScreen.checked,
    defaultPinned: fields.defaultPinned.checked,
    showRailLine: fields.showRailLine.checked,
  });
}

function writeForm(settings) {
  fields.maxOutlineItems.value = settings.maxOutlineItems;
  fields.onlyUserMessages.checked = settings.onlyUserMessages;
  fields.panelRight.value = settings.panelRight;
  fields.expandedWidth.value = settings.expandedWidth;
  fields.tickMapHeight.value = settings.tickMapHeight;
  fields.autoHideOnSmallScreen.checked = settings.autoHideOnSmallScreen;
  fields.defaultPinned.checked = settings.defaultPinned;
  fields.showRailLine.checked = settings.showRailLine;
}

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    const settings = normalizeSettings(result[STORAGE_KEY] || DEFAULT_SETTINGS);
    writeForm(settings);
    setStatus('已加载当前设置');
  } catch (error) {
    console.error('[Outline options] load settings failed:', error);
    writeForm(DEFAULT_SETTINGS);
    setStatus('设置加载失败，已显示默认值');
  }
}

async function saveSettings() {
  const settings = readForm();
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  writeForm(settings);
  setStatus('保存成功，已同步到打开的 ChatGPT 页面');
}

async function resetSettings() {
  await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  writeForm(DEFAULT_SETTINGS);
  setStatus('已恢复默认设置');
}

saveBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  await saveSettings();
});

resetBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  await resetSettings();
});

form.addEventListener('input', () => {
  setStatus('设置已修改，记得保存');
});

loadSettings();
