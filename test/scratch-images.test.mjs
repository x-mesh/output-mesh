import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatedImages, scratchImages } from '../lib/scratch-images.mjs';
import { ingestFile, sweepGeneratedImages, sweepScratchImages } from '../lib/collector.mjs';
import { CatalogStore } from '../lib/store.mjs';
import { locationOf } from '../lib/describe.mjs';
import { activity, facets, overview, recentChanges, search } from '../lib/search.mjs';

const SESSION = 'f474cde7-8f84-4783-971c-b0cf014513c7';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let root;
let store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'output-mesh-scratch-'));
  store = new CatalogStore(join(root, 'c.db'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const write = (path, body = PNG) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const pad = (session = SESSION) => join(root, 'tmp', '-Users-me-proj', session, 'scratchpad');

describe('세션 작업 폴더의 이미지', () => {
  test('이미지만 고르고, 복제한 저장소 · 브라우저 프로필 · 의존성 · 점 폴더 · 깊은 곳은 건너뛴다', () => {
    const shot = write(join(pad(), 'shots', 'after', 'desktop.png'));
    const top = write(join(pad(), 'chart.webp'));
    write(join(pad(), 'pr-body.md'), '# 본문');
    write(join(pad(), 'repos', 'clone', 'package.json'), '{}');
    write(join(pad(), 'repos', 'clone', 'docs', 'logo.png'));
    write(join(pad(), 'ui', 'profile', 'Local State'), '{}');
    write(join(pad(), 'ui', 'profile', 'Default', 'favicon.png'));
    write(join(pad(), 'node_modules', 'pkg', 'icon.png'));
    write(join(pad(), '.cache', 'x.png'));
    write(join(pad(), 'a', 'b', 'c', 'd', 'deep.png'));
    write(join(root, 'tmp', '-Users-me-proj', SESSION, 'tasks', 'out.png'));
    write(join(root, 'tmp', '-Users-me-proj', 'not-a-session', 'scratchpad', 'x.png'));

    expect(scratchImages(join(root, 'tmp')).map((image) => [image.path, image.sessionRef]).sort())
      .toEqual([[shot, SESSION], [top, SESSION]].sort());
  });

  test('그 Claude Code 세션의 출처로 붙고, 작업공간과 제목은 같은 세션의 다른 출처에서 빌린다', async () => {
    const workspace = join(root, 'proj');
    const script = write(join(workspace, 'shot.mjs'), 'x');
    await ingestFile(store, script, { collector: 'claude-code', provider: 'claude-code', sessionRef: SESSION, workspace, sessionTitle: '상단 바 정렬' });
    const shot = write(join(pad(), 'shots', 'after.png'));
    const lone = write(join(pad('80ded884-0000-4000-8000-000000000000'), 'only.png'));

    expect(await sweepScratchImages(store, join(root, 'tmp'))).toMatchObject({ found: 2, inserted: 2, failed: 0 });
    const origin = (path) => store.originsOf(store.byPathKey(path).id).map((o) => [o.collector, o.provider, o.session_ref, o.workspace, o.session_title]);
    expect(origin(shot)).toEqual([['claude-code', 'claude-code', SESSION, workspace, '상단 바 정렬']]);
    expect(origin(lone)).toEqual([['claude-code', 'claude-code', '80ded884-0000-4000-8000-000000000000', null, null]]);
    expect(store.counts().artifactsWithoutOrigin).toBe(0);

    // 이미 아는 파일은 다시 넣지 않는다. 바뀜과 사라짐은 다시 확인이 맡는다.
    expect(await sweepScratchImages(store, join(root, 'tmp'))).toMatchObject({ found: 2, inserted: 0 });
  });

  test('위치는 긴 임시 경로 대신 세션의 저장소와 작업 폴더 안 위치, 그리고 임시라는 표시다', () => {
    const path = `/private/tmp/claude-501/-Users-me-proj/${SESSION}/scratchpad/shots/after.png`;
    expect(locationOf(path, ['/Users/me/proj'], '/Users/me')).toEqual({ repo: 'proj', dir: 'shots/', scratch: SESSION });
    expect(locationOf(`/tmp/claude-501/x/${SESSION}/scratchpad/a.png`, [], '/Users/me')).toEqual({ repo: null, dir: '/', scratch: SESSION });
    expect(locationOf('/Users/me/proj/docs/a.png', ['/Users/me/proj'], '/Users/me')).toEqual({ repo: 'proj', dir: 'docs/' });
  });
});

describe('활동 보기의 임시 이미지', () => {
  test('세션의 다른 파일과 섞지 않고 따로 준다 — scratchOnly 는 그 이미지가 있는 세션만 센다', async () => {
    // 위치 규칙이 실제 임시 폴더 모양(`<tmp>/claude-*/…/scratchpad/`)을 보므로 그 모양으로 만든다.
    const tmp = mkdtempSync(join(realpathSync('/tmp'), 'claude-om-test-'));
    try {
      write(join(tmp, '-Users-me-proj', SESSION, 'scratchpad', 'shots', 'after.png'));
      const notes = write(join(root, 'proj', 'notes.md'), '# 메모');
      await ingestFile(store, notes, { collector: 'claude-code', provider: 'claude-code', sessionRef: SESSION, workspace: join(root, 'proj') });
      const other = write(join(root, 'other', 'b.md'), '# 다른 세션');
      await ingestFile(store, other, { collector: 'claude-code', provider: 'claude-code', sessionRef: 'other-session' });
      await sweepScratchImages(store, tmp);

      // 기본은 숨김이다. 켜야 세션 카드에 따로 묶여 나온다.
      expect(activity(store).find((session) => session.session_ref === SESSION).scratch).toEqual([]);
      const mine = activity(store, { temporary: true }).find((session) => session.session_ref === SESSION);
      expect(mine.files.map((file) => file.file_name)).toEqual(['notes.md']);
      expect(mine.scratch.map((file) => file.file_name)).toEqual(['after.png']);
      expect([mine.file_count, mine.scratch_count]).toEqual([2, 1]);
      expect(activity(store, { scratchOnly: true }).map((session) => [session.session_ref, session.files.length, session.scratch.length]))
        .toEqual([[SESSION, 0, 1]]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('임시 파일 토글', () => {
  test('기본은 목록 · 건수 · 피드에서 빼고 숨긴 수를 알린다. 켜면 모두 보인다', async () => {
    const tmp = mkdtempSync(join(realpathSync('/tmp'), 'claude-om-test-'));
    try {
      write(join(tmp, '-Users-me-proj', SESSION, 'scratchpad', 'a.png'));
      write(join(tmp, '-Users-me-proj', SESSION, 'scratchpad', 'b.png'));
      const kept = write(join(root, 'proj', 'shot.png'));
      await ingestFile(store, kept, { collector: 'claude-code', provider: 'claude-code', sessionRef: SESSION, workspace: join(root, 'proj') });
      await sweepScratchImages(store, tmp);
      const names = (filters) => search(store, '', { view: 'library', ...filters }).map((row) => row.file_name).sort();

      expect(names({})).toEqual(['shot.png']);
      expect(names({ temporary: true })).toEqual(['a.png', 'b.png', 'shot.png']);
      expect(facets(store, { view: 'library' }).temporaryHidden).toBe(2);
      expect(facets(store, { view: 'library', temporary: true }).temporaryHidden).toBe(0);
      expect(facets(store, { view: 'library' }).kinds.find((k) => k.value === 'image').n).toBe(1);
      expect([overview(store).library, overview(store, undefined, { temporary: true }).library]).toEqual([1, 3]);

      const feed = recentChanges(store, '', { view: 'library' });
      expect([feed.changes.map((c) => c.file_name), feed.hidden.temporary]).toEqual([['shot.png'], 2]);
      expect(recentChanges(store, '', { view: 'library', temporary: true }).changes.map((c) => c.file_name).sort()).toEqual(['a.png', 'b.png', 'shot.png']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Codex 생성 그림', () => {
  const THREAD = '019feddb-6ee2-7412-bb22-ef4ccf062c1f';
  const generatedRoot = () => join(root, 'home', '.codex', 'generated_images');

  test('스레드 폴더 바로 아래의 그림만 고르고, 그 Codex 세션의 출처로 붙는다', async () => {
    const image = write(join(generatedRoot(), THREAD, 'exec-1.png'));
    write(join(generatedRoot(), THREAD, 'notes.txt'), 'x');
    write(join(generatedRoot(), THREAD, 'nested', 'deep.png'));
    write(join(generatedRoot(), 'not-a-thread', 'x.png'));
    expect(generatedImages(generatedRoot()).map((found) => [found.path, found.sessionRef])).toEqual([[image, THREAD]]);

    const workspace = join(root, 'ai-mesh');
    await ingestFile(store, write(join(workspace, 'a.md'), '# a'), { collector: 'codex', provider: 'openai-codex', sessionRef: THREAD, workspace, sessionTitle: '턴이 끊긴다' });
    expect(await sweepGeneratedImages(store, generatedRoot())).toMatchObject({ found: 1, inserted: 1 });
    expect(store.originsOf(store.byPathKey(image).id).map((o) => [o.collector, o.provider, o.session_ref, o.workspace, o.session_title]))
      .toEqual([['codex', 'openai-codex', THREAD, workspace, '턴이 끊긴다']]);
  });

  test('임시 이미지와 같이 기본으로 숨기고, 위치에는 생성 그림이라고 적는다', async () => {
    const image = write(join(generatedRoot(), THREAD, 'exec-1.png'));
    await sweepGeneratedImages(store, generatedRoot());
    const names = (filters) => search(store, '', { view: 'library', ...filters }).map((row) => row.file_name);
    expect(names({})).toEqual([]);
    expect(names({ temporary: true })).toEqual(['exec-1.png']);
    expect(locationOf(`/Users/me/.codex/generated_images/${THREAD}/exec-1.png`, ['/Users/me/ai-mesh'], '/Users/me'))
      .toEqual({ repo: 'ai-mesh', dir: '/', scratch: THREAD, generated: true });
    expect(image.endsWith('exec-1.png')).toBe(true);
  });
});
