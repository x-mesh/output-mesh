import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { columnIndex, columnName, parseSharedStrings, parseSheet, parseWorkbook, readSheets } from '../lib/sheet.mjs';

describe('열 이름', () => {
  test.each([['A', 0], ['Z', 25], ['AA', 26], ['AZ', 51], ['BA', 52], ['XFD', 16383]])('%s ↔ %d', (letters, index) => {
    expect(columnIndex(letters)).toBe(index);
    expect(columnName(index)).toBe(letters);
  });
});

describe('xlsx XML 읽기', () => {
  test('공유 문자열은 서식 조각을 이어 붙이고 수치 참조를 푼다', () => {
    const xml = '<sst><si><t>매출</t></si><si><r><t>분기</t></r><r><t xml:space="preserve"> 합계</t></r></si><si><t>&#54633;&amp;</t></si></sst>';
    expect(parseSharedStrings(xml)).toEqual(['매출', '분기 합계', '합&']);
  });

  test('시트 이름과 위치 — 상대 경로와 절대 경로 둘 다', () => {
    const workbook = '<sheets><sheet name="요약" sheetId="1" r:id="rId1"/><sheet name="A &amp; B" sheetId="2" r:id="rId2"/></sheets>';
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
    expect(parseWorkbook(workbook, rels)).toEqual([
      { name: '요약', path: 'xl/worksheets/sheet1.xml' },
      { name: 'A & B', path: 'xl/worksheets/sheet2.xml' },
    ]);
  });

  test('셀 종류별 값을 읽고 빈 칸은 채우며 빈 행은 건너뛴다 — 원래 행 번호는 남긴다', () => {
    const xml = '<worksheet><dimension ref="A1:D5"/><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>인라인</t></is></c></row>'
      + '<row r="2"/>'
      + '<row r="4"><c r="A4"><v>1234.5</v></c><c r="B4" t="b"><v>1</v></c><c r="D4" t="str"><v>계산됨</v></c></row>'
      + '</sheetData></worksheet>';
    const sheet = parseSheet(xml, ['공유']);
    expect(sheet.rows).toEqual([
      { n: 1, cells: ['공유', '', '인라인', ''] },
      { n: 4, cells: ['1234.5', 'TRUE', '', '계산됨'] },
    ]);
    expect([sheet.columns, sheet.totalRows, sheet.totalCols, sheet.truncated]).toEqual([4, 5, 4, false]);
  });

  test('행·열 상한에서 자르고 잘렸다고 알린다 — 수천 행 시트를 다 그리면 화면이 굳는다', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      `<row r="${i + 1}">${['A', 'B', 'C', 'D'].map((col) => `<c r="${col}${i + 1}"><v>${i}</v></c>`).join('')}</row>`).join('');
    const sheet = parseSheet(`<worksheet><dimension ref="A1:D10"/><sheetData>${rows}</sheetData></worksheet>`, [], { maxRows: 3, maxCols: 2 });
    expect(sheet.rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(sheet.rows[0].cells).toEqual(['0', '0']);
    expect([sheet.columns, sheet.totalRows, sheet.totalCols, sheet.truncated]).toEqual([2, 10, 4, true]);
  });
});

describe('xlsx 파일', () => {
  let dir;
  let file;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'output-mesh-sheet-'));
    const root = join(dir, 'book');
    mkdirSync(join(root, 'xl', 'worksheets'), { recursive: true });
    mkdirSync(join(root, 'xl', '_rels'), { recursive: true });
    writeFileSync(join(root, 'xl', 'workbook.xml'), '<workbook><sheets><sheet name="매출" sheetId="1" r:id="rId1"/></sheets></workbook>');
    writeFileSync(join(root, 'xl', '_rels', 'workbook.xml.rels'), '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    writeFileSync(join(root, 'xl', 'sharedStrings.xml'), '<sst><si><t>분기</t></si></sst>');
    writeFileSync(join(root, 'xl', 'worksheets', 'sheet1.xml'), '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
    file = join(dir, 'book.xlsx');
    await Bun.spawn(['/usr/bin/zip', '-qr', file, 'xl'], { cwd: root }).exited;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('zip 안의 시트를 표로 읽는다', async () => {
    const { sheets } = await readSheets(file);
    expect(sheets).toEqual([{ name: '매출', columns: 2, rows: [{ n: 1, cells: ['분기', '42'] }], totalRows: 2, totalCols: 2, truncated: false }]);
  });

  test('xlsx 가 아닌 zip 은 빈 결과와 이유를 준다', async () => {
    const other = join(dir, 'other.zip');
    writeFileSync(join(dir, 'note.txt'), 'x');
    await Bun.spawn(['/usr/bin/zip', '-q', other, 'note.txt'], { cwd: dir }).exited;
    expect(await readSheets(other)).toEqual({ sheets: [], error: 'not_xlsx' });
  });
});
