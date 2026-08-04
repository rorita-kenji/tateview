// settings.js — 設定と現在位置の LocalStorage 保存/復元
import { makeRecord, restoreOffset } from '../modules/position.js';

const SETTINGS_KEY = 'tategaki-settings';
const POS_PREFIX = 'tategaki-position:';

export const PRESETS = [
  { name: '20字 × 20行', charsPerColumn: 20, columnsPerPage: 20 },
  { name: '40字 × 16行', charsPerColumn: 40, columnsPerPage: 16 },
  { name: '40字 × 32行', charsPerColumn: 40, columnsPerPage: 32 },
  { name: '40字 × 34行', charsPerColumn: 40, columnsPerPage: 34 },
  { name: '42字 × 34行', charsPerColumn: 42, columnsPerPage: 34 },
];

export const DEFAULT_SETTINGS = {
  presetIndex: 1,
  charsPerColumn: 40,
  columnsPerPage: 16,
  theme: 'light',
  fontFamily: 'mincho',
  fontSize: 20,
  fontSizeAuto: true,
  kinsoku: true,
  burasage: true,
  showRuby: true,
  halfColor: true,
  spaceColor: false,
  gridLines: false,
  fullwidthAlpha: true,
  fullwidthDigit: true,
  /** @deprecated 互換用。実体は headCfg */
  chapterMark: '#',
  /** @deprecated 互換用。実体は headCfg */
  episodeMark: '##',
  /**
   * 見出し設定（novedit 型・Lv1/Lv2 のみ）
   * lv1/lv2 は空白区切りの複数記号可。builtin はキーワード検出 ON/OFF。
   */
  headCfg: {
    // novedit HEAD_DEFAULT と一致
    lv1: '# ＃ §',
    lv2: '▼ ▽ ■ □ ● 〇 ○ ## ＃＃',
    lv1On: true,
    lv2On: true,
    builtin: {
      chapterNum: true,
      chapterWord: true,
      episodeNum: true,
      episodeWord: true,
    },
  },
};

/** headCfg と旧 chapterMark/episodeMark を揃える */
export function syncHeadingSettings(s) {
  const base = s || { ...DEFAULT_SETTINGS };
  const hcIn = base.headCfg && typeof base.headCfg === 'object' ? base.headCfg : null;
  const headCfg = {
    lv1: hcIn && hcIn.lv1 != null ? String(hcIn.lv1) : (base.chapterMark != null ? String(base.chapterMark) : '#'),
    lv2: hcIn && hcIn.lv2 != null ? String(hcIn.lv2) : (base.episodeMark != null ? String(base.episodeMark) : '##'),
    lv1On: !(hcIn && hcIn.lv1On === false),
    lv2On: !(hcIn && hcIn.lv2On === false),
    builtin: {
      chapterNum: true,
      chapterWord: true,
      episodeNum: true,
      episodeWord: true,
      ...(hcIn && hcIn.builtin && typeof hcIn.builtin === 'object' ? hcIn.builtin : {}),
    },
  };
  if (!String(headCfg.lv1).trim()) headCfg.lv1 = '# ＃ §';
  if (!String(headCfg.lv2).trim()) headCfg.lv2 = '▼ ▽ ■ □ ● 〇 ○ ## ＃＃';
  // 旧キーは先頭トークン（警告・検索の簡易パス用）
  const t1 = String(headCfg.lv1).trim().split(/\s+/)[0] || '#';
  const t2 = String(headCfg.lv2).trim().split(/\s+/)[0] || '▼';
  base.headCfg = headCfg;
  base.chapterMark = t1;
  base.episodeMark = t2;
  return base;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return syncHeadingSettings({ ...DEFAULT_SETTINGS });
    return syncHeadingSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return syncHeadingSettings({ ...DEFAULT_SETTINGS });
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(syncHeadingSettings(s)));
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
