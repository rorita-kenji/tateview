// settings.js — 設定と現在位置の LocalStorage 保存/復元
import { makeRecord, restoreOffset } from '../modules/position.js';

const SETTINGS_KEY = 'tategaki-settings';
const POS_PREFIX = 'tategaki-position:';

export const PRESETS = [
  { name: '20字 × 20行（400字）', charsPerColumn: 20, columnsPerPage: 20 },
  { name: '40字 × 18行（720字）', charsPerColumn: 40, columnsPerPage: 18 },
  { name: '42字 × 18行（756字）', charsPerColumn: 42, columnsPerPage: 18 },
  { name: '40字 × 20行（800字）', charsPerColumn: 40, columnsPerPage: 20 },
  { name: '42字 × 20行（840字）', charsPerColumn: 42, columnsPerPage: 20 },
];

export const DEFAULT_SETTINGS = {
  presetIndex: 1,
  charsPerColumn: 40,
  columnsPerPage: 18,
  theme: 'light',
  fontFamily: 'mincho',
  fontSize: 20,
  kinsoku: true,
  burasage: true,
  showRuby: true,
  halfColor: true,
  spaceColor: false,
  gridLines: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function savePosition(fileName, text, offset) {
  try {
    localStorage.setItem(POS_PREFIX + fileName, JSON.stringify(makeRecord(text, offset)));
  } catch {
    /* ignore */
  }
}
export function loadPosition(fileName, text) {
  try {
    const raw = localStorage.getItem(POS_PREFIX + fileName);
    if (!raw) return 0;
    return restoreOffset(text, JSON.parse(raw));
  } catch {
    return 0;
  }
}
