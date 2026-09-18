import { decodeEntities, runCapped } from './extract.mjs';
import { MAX_PREVIEW_SHEETS, SHEET_PREVIEW_COLS, SHEET_PREVIEW_ROWS, SHEET_PREVIEW_XML_BYTES } from './paths.mjs';

/**
 * xlsx 를 간단한 표로 보인다. xlsx 는 zip 이고 시트마다 XML 이 하나다. 값만 읽는다 — 날짜 서식,
 * 병합, 색, 차트는 보이지 않고 수식은 마지막으로 계산된 값이 나온다. 파싱 함수는 파일시스템을
 * 만지지 않아 문자열 픽스처로 시험한다.
 */

const LETTERS = 26;
const CHAR_A = 'A'.charCodeAt(0);
// 목록·관계 파일은 작다. 이보다 크면 시트가 아니라 다른 무언가다.
const SMALL_PART_BYTES = 256 * 1024;

export function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * LETTERS + (char.charCodeAt(0) - CHAR_A + 1);
  return index - 1;
}

export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / LETTERS)) {
    name = String.fromCharCode(CHAR_A + ((n - 1) % LETTERS)) + name;
  }
  return name;
}

const attr = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
const texts = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1])).join('');

/** 공유 문자열 표. 한 항목이 서식 조각(<r>) 여러 개로 나뉘어 있으면 이어 붙인다. */
export function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
}

/** 시트 이름과 XML 위치. 순서는 엑셀 탭 순서다. */
export function parseWorkbook(workbookXml, relsXml) {
  const targets = new Map([...relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  return [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const target = targets.get(attr(m[1], 'r:id')) ?? '';
    // 대상은 xl/ 기준 상대 경로가 보통이지만 절대 경로(/xl/...)로 적는 도구도 있다.
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: decodeEntities(attr(m[1], 'name') ?? ''), path };
  });
}

function cellValue(attrs, inner, shared) {
  const type = attr(attrs, 't');
  if (type === 'inlineStr') return texts(inner);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return decodeEntities(raw);
}

/**
 * 앞 maxRows 행, maxCols 열만 읽는다. 빈 행은 건너뛰고 원래 행 번호를 남긴다.
 * 잘렸는지는 <dimension> 으로 판단하지 않는다 — 서식만 입힌 빈 행까지 범위에 넣는 도구가 있어서
 * 다 보여줘도 잘렸다고 말하게 된다. 실제로 멈춘 경우만 센다: 행 상한, 상한 밖 열의 값,
 * 바이트 상한에서 잘린 XML.
 */
export function parseSheet(xml, shared, { maxRows = SHEET_PREVIEW_ROWS, maxCols = SHEET_PREVIEW_COLS } = {}) {
  const rows = [];
  let widest = 0;
  let cutRows = false;
  let cutCols = false;
  for (const match of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= maxRows) {
      cutRows = true;
      break;
    }
    const cells = [];
    for (const cell of (match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /^([A-Z]+)(\d+)$/.exec(attr(cell[1], 'r') ?? '');
      const col = ref ? columnIndex(ref[1]) : cells.length;
      if (col >= maxCols) {
        cutCols ||= cellValue(cell[1], cell[2] ?? '', shared) !== '';
        continue;
      }
      cells[col] = cellValue(cell[1], cell[2] ?? '', shared);
    }
    if (cells.every((value) => value === undefined || value === '')) continue;
    widest = Math.max(widest, cells.length);
    rows.push({ n: Number(attr(match[1], 'r')) || rows.length + 1, cells: Array.from(cells, (value) => value ?? '') });
  }

  const dimension = /<dimension\b[^>]*\bref="(?:[A-Z]+\d+:)?([A-Z]+)(\d+)"/.exec(xml);
  const totalRows = dimension ? Number(dimension[2]) : rows.at(-1)?.n ?? 0;
  const totalCols = dimension ? columnIndex(dimension[1]) + 1 : widest;
  return {
    columns: Math.min(Math.max(widest, 1), maxCols),
    rows: rows.map((row) => ({ n: row.n, cells: [...row.cells, ...Array(Math.max(0, widest - row.cells.length)).fill('')] })),
    totalRows,
    totalCols,
    truncated: cutRows || cutCols || (rows.length > 0 && !xml.includes('</sheetData>')),
  };
}

const unzipText = (absPath, entry, cap) => runCapped(['/usr/bin/unzip', '-p', absPath, entry], cap);

export async function readSheets(absPath) {
  const entries = new Set((await runCapped(['/usr/bin/unzip', '-Z1', absPath], SMALL_PART_BYTES)).split('\n').map((s) => s.trim()));
  if (!entries.has('xl/workbook.xml')) return { sheets: [], error: 'not_xlsx' };
  const [workbook, rels] = await Promise.all([
    unzipText(absPath, 'xl/workbook.xml', SMALL_PART_BYTES),
    unzipText(absPath, 'xl/_rels/workbook.xml.rels', SMALL_PART_BYTES),
  ]);
  // 공유 문자열이 상한에서 잘리면 뒤쪽 칸이 비어 보인다. 앞부분을 보여주는 미리보기라 받아들인다.
  const shared = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(await unzipText(absPath, 'xl/sharedStrings.xml', SHEET_PREVIEW_XML_BYTES))
    : [];
  const listed = parseWorkbook(workbook, rels).filter((sheet) => entries.has(sheet.path));
  const sheets = [];
  for (const sheet of listed.slice(0, MAX_PREVIEW_SHEETS)) {
    const xml = await unzipText(absPath, sheet.path, SHEET_PREVIEW_XML_BYTES);
    sheets.push({ name: sheet.name, ...parseSheet(xml, shared) });
  }
  return { sheets, moreSheets: Math.max(0, listed.length - MAX_PREVIEW_SHEETS) };
}
