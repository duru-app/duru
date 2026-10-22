import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { addJudgment } from '../src/judgments.ts';
import { loadMarks } from '../src/marks.ts';
import { withRebuiltFixture, signer, withServer, postMark, initGitRepoNamed, rebuild, browserMissing, toList, withPage, openScreenInfo, openLinkGroups, screenBox, tipLines, needTag, DOCUMENT_TABLE, HOME_NODE, CASE_KINDS } from './review-helpers.ts';
import type { Config, PageData, Kept } from './review-helpers.ts';

test('in a browser, the header does not name an author taken from the config, and a mark saved on the page is signed with the config author even when git has a name', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ author: '설정 이름' }, (config, copy) => {
    initGitRepoNamed(copy, 'Git 이름');
    return withServer(config, undefined, (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent('#author'), '');
        assert.equal(await p.locator('header input').count(), 0);
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("테스트 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => m.author), ['설정 이름']);
      }),
    );
  });
});

test('in a browser, the header names the author only when the name is the computer user name, and says why', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    for (const source of ['config', 'git']) {
      await withServer(config, signer('reviewer', source), (base) =>
        withPage(base, async (p) => {
          await p.waitForSelector('#screen-list li');
          assert.equal(await p.textContent('#author'), '', source);
        }));
    }
    await withServer(config, signer('hit0607', 'user'), (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent('#author'), '작성자 hit0607');
        assert.match((await p.getAttribute('#author', 'title'))!, /컴퓨터 사용자 이름/);
      }));
  });
});

test('in a browser, marks and judgments show only their date while every one of them is the reviewer\'s own, and show the names once another person\'s is among them', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#right .statuses button:has-text("테스트 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li');
        await p.locator('#center .importers .importer', { hasText: 'renders the help text' }).locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        const signed = () => Promise.all(['#right .history li .muted', '#center .awaiting-tag .importer .detail .muted'].map((sel) => p.textContent(sel)));
        for (const text of await signed()) {
          assert.doesNotMatch(text!, /reviewer/);
          assert.match(text!, /\d/);
        }

        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged elsewhere', author: 'someone' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        for (const text of await signed()) assert.match(text!, /reviewer · /);
        await p.click('#screen-list li:has-text("/home")');
        assert.match((await p.textContent('#center .discarded .importer'))!, /judged elsewhere · someone · /);
      })));
});

for (const host of ['127.0.0.1', 'localhost']) {
  test(`in a browser at ${host}, the list filters screens, a mark is saved as a file and is there after reloading`, { skip: browserMissing }, async () => {
    await withRebuiltFixture({}, (config) =>
      withServer(config, 'reviewer', (base) =>
        withPage(base.replace('127.0.0.1', host), async (p) => {
          await p.waitForSelector('#screen-list li');
          assert.equal(await p.locator('#screen-list li').count(), 11);
          assert.equal(await p.textContent('#author'), '');

          await p.fill('#left input[type=search]', 'lab');
          assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
          await p.fill('#left input[type=search]', '');
          await p.check('#left input[name=no-tests]');
          const noTests = await p.locator('#screen-list li').allTextContents();
          assert.ok(noTests.length > 0 && noTests.every((t) => t.includes('테스트 없음')));
          await p.uncheck('#left input[name=no-tests]');

          await p.click('#screen-list li:has-text("/document/:id")');
          assert.equal(await p.textContent('#center h3'), '/document/:id');
          await p.click('#center tr:has-text("API")');
          assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
          assert.equal(await p.isDisabled('#right button.save'), true);
          await p.click('#right .statuses button:has-text("테스트 필요")');
          await p.fill('#right-dock textarea', 'no API test yet');
          await p.click('#right button.save');
          await p.waitForSelector('#right .history li:has-text("no API test yet")');
          assert.match((await p.textContent('#center tr.selected td.mark'))!, /테스트 필요/);
          assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.note, m.author]), [
            [{ node: '/document/:id#DocumentDetail', depth: 'api' }, 'needs-more', 'no API test yet', 'reviewer'],
          ]);

          await p.click('#center tr:has-text("화면 전체")');
          await p.click('#right .statuses button:has-text("충분")');
          await p.click('#right button.save');
          await p.waitForSelector('#screen-list li.selected .chip');
          assert.equal(await p.textContent('#screen-list li.selected .chip'), '충분');

          await p.reload();
          await toList(p);
          await p.click('#screen-list li:has-text("/document/:id")');
          await p.click('#center tr:has-text("API")');
          assert.ok((await p.locator('#right .history li').allTextContents()).some((t) => t.includes('no API test yet')));

          await p.emulateMedia({ colorScheme: 'dark' });
          assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
        }),
      ),
    );
  });
}

test('in a browser, drawing the screens side again keeps the search box and its filtering, and draws the 「떨어져 나감」 block once with the marks read again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const search = '#left input[type=search]';
        const detachedHeadings = () => p.locator('#left h2:has-text("떨어져 나감")').allTextContents();
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 0']);
        await p.fill(search, 'lab');
        await p.$eval(search, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await postMark(base, { target: { node: '/gone#Gone' }, status: 'missing' });
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip');
        assert.equal(await p.$eval(search, (el: HTMLInputElement & Kept) => el.kept), true);
        assert.equal(await p.inputValue(search), 'lab');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 1']);
        assert.deepEqual(await p.locator('#left .detached li code').allTextContents(), ['/gone#Gone']);
      })));
});

test('in a browser, the two left tabs stay on one line inside the column, also with three-digit counts and a classic scrollbar', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let counts: { screens: number; untagged?: number } = { screens: 11 };
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          const grow = <T>(list: T[], n: number) => Array.from({ length: n }, (_, i) => list[i % list.length]);
          data.map.screens = grow(data.map.screens, counts.screens);
          if (counts.untagged !== undefined) {
            delete data.tests.untagged;
            data.tests.untaggedCount = counts.untagged;
          }
          await route.fulfill({ response: res, json: data });
        });
        const measure = () => p.evaluate(() => {
          const left = document.getElementById('left')!;
          const row = left.querySelector('.views.side')!;
          const probe = row.cloneNode(true) as HTMLElement;
          probe.style.cssText = 'position: absolute; visibility: hidden; width: 1000px';
          for (const b of [...probe.children].slice(1)) b.remove();
          probe.querySelector('.tab-name')!.textContent = '가';
          probe.querySelector('.tab-count')!.textContent = '1';
          left.append(probe);
          const oneLine = probe.firstElementChild!.getBoundingClientRect().height;
          probe.remove();
          const middle = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
          const tabs = [...row.children];
          return {
            heights: tabs.map((b) => b.getBoundingClientRect().height),
            oneLine,
            drop: tabs.map((b) => Math.abs(middle(b.querySelector('.tab-name')!) - middle(b.querySelector('.tab-count')!))),
            inside: tabs.map((b) => {
              const box = b.getBoundingClientRect();
              const name = b.querySelector('.tab-name')!.getBoundingClientRect();
              const count = b.querySelector('.tab-count')!.getBoundingClientRect();
              const edge = b.clientLeft + parseFloat(getComputedStyle(b).paddingLeft);
              return name.left >= box.left + edge - 0.5 && name.right <= count.left && count.right <= box.right - edge + 0.5;
            }),
            cut: tabs.map((b) => {
              const name = b.querySelector('.tab-name')!;
              const text = document.createRange();
              text.selectNodeContents(name);
              return name.getBoundingClientRect().width < text.getBoundingClientRect().width - 0.1;
            }),
            labels: tabs.map((b) => b.textContent),
            rowScroll: [row.scrollWidth, row.clientWidth],
            leftScroll: [left.scrollWidth, left.clientWidth],
          };
        });
        const assertFits = (m: Awaited<ReturnType<typeof measure>>, why: string) => {
          assert.deepEqual(m.heights, Array(2).fill(m.oneLine), `${why}: every tab is as tall as a one-line tab`);
          assert.ok(m.drop.every((d) => d <= 3), `${why}: each count stays beside its name ${m.drop}`);
          assert.deepEqual(m.inside, Array(2).fill(true), `${why}: name and count stay inside their tab's padding`);
          assert.ok(m.rowScroll[0] <= m.rowScroll[1], `${why}: row ${m.rowScroll[0]} fits in ${m.rowScroll[1]}`);
          assert.ok(m.leftScroll[0] <= m.leftScroll[1], `${why}: left column ${m.leftScroll[0]} does not scroll sideways in ${m.leftScroll[1]}`);
        };
        const show = async (c: typeof counts) => {
          counts = c;
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
        };

        const scrollbar = () => p.addStyleTag({ content: '#left { padding-right: 31px !important; }' });

        await show({ screens: 11 });
        let m = await measure();
        assert.deepEqual(m.labels, ['화면 11', '태그 없음 13']);
        assert.deepEqual(m.cut, [false, false]);
        assertFits(m, 'default counts');

        await show({ screens: 111, untagged: 999 });
        m = await measure();
        assert.deepEqual(m.labels, ['화면 111', '태그 없음 999']);
        assert.deepEqual(m.cut, [false, false]);
        assertFits(m, 'three-digit counts');

        await show({ screens: 111, untagged: 999 });
        await scrollbar();
        m = await measure();
        assert.deepEqual(m.cut, [false, false]);
        assertFits(m, 'three-digit counts with a classic scrollbar');

        await show({ screens: 111, untagged: 999 });
        await scrollbar();
        await p.click('#left .views.side button:nth-child(2)');
        assertFits(await measure(), 'three-digit counts on every tab, a classic scrollbar and the widest tab chosen');
      })));
});

test('in a browser, with 「경우 종류」 as a third left tab, a tab that does not fit beside the others moves whole to a second line, so no tab name is cut, also with three-digit counts and a classic scrollbar', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: { boundary: CASE_KINDS.boundary } }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let counts: { screens: number; untagged: number; undecided: number } | null = null;
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData & { caseTargets: Record<string, { undecided: string[] }> } = await res.json();
          if (counts) {
            const grow = <T>(list: T[], n: number) => Array.from({ length: n }, (_, i) => list[i % list.length]);
            data.map.screens = grow(data.map.screens, counts.screens);
            delete data.tests.untagged;
            data.tests.untaggedCount = counts.untagged;
            data.caseTargets.boundary.undecided = grow(data.caseTargets.boundary.undecided, counts.undecided);
          }
          await route.fulfill({ response: res, json: data });
        });
        const measure = () => p.evaluate(() => {
          const left = document.getElementById('left')!;
          const row = left.querySelector('.views.side')!;
          const tabs = [...row.children];
          return {
            labels: tabs.map((b) => b.textContent),
            tops: tabs.map((b) => Math.round(b.getBoundingClientRect().top)),
            heights: tabs.map((b) => Math.round(b.getBoundingClientRect().height)),
            cut: tabs.map((b) => {
              const name = b.querySelector('.tab-name')!;
              const text = document.createRange();
              text.selectNodeContents(name);
              return name.getBoundingClientRect().width < text.getBoundingClientRect().width - 0.1;
            }),
            rowScroll: [row.scrollWidth, row.clientWidth],
            leftScroll: [left.scrollWidth, left.clientWidth],
          };
        });
        const show = async (c: typeof counts, scrollbar: boolean) => {
          counts = c;
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
          if (scrollbar) await p.addStyleTag({ content: '#left { padding-right: 31px !important; }' });
          const m = await measure();
          assert.deepEqual(m.cut, [false, false, false], `${m.labels}: no tab name is cut`);
          assert.equal(new Set(m.heights).size, 1, `${m.labels}: every tab is one line tall ${m.heights}`);
          assert.ok(m.rowScroll[0] <= m.rowScroll[1] && m.leftScroll[0] <= m.leftScroll[1], `${m.labels}: nothing scrolls sideways`);
          return m;
        };

        let m = await show(null, false);
        assert.deepEqual(m.labels, ['화면 11', '태그 없음 13', '경우 종류 21']);
        assert.equal(new Set(m.tops).size, 1, 'the three tabs share one line while they fit');

        for (const scrollbar of [false, true]) {
          m = await show({ screens: 111, untagged: 999, undecided: 425 }, scrollbar);
          assert.deepEqual(m.labels, ['화면 111', '태그 없음 999', '경우 종류 425']);
          assert.ok(m.tops[0] === m.tops[1] && m.tops[2] > m.tops[0], `the case tab moves below the other two ${m.tops}`);
        }
      })));
});

test('in a browser, the dead screen filter keeps the screens that call an API missing on the server', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=dead]');
        assert.deepEqual(await names(), ['/home', '/document/:tab(draft|done)']);
        assert.deepEqual(await p.locator('#screen-list li .chip.dead').allTextContents(), ['죽은 화면', '죽은 화면']);
        await p.fill('#left input[type=search]', 'home');
        assert.deepEqual(await names(), ['/home']);
        await p.fill('#left input[type=search]', '');
        await p.check('#left input[name=no-tests]');
        assert.deepEqual(await names(), []);
        await p.uncheck('#left input[name=dead]');
        assert.ok((await names()).length > 0);
        await p.uncheck('#left input[name=no-tests]');
        assert.equal((await names()).length, 11);
      }),
    ),
  );
});

const LONG_PATH = '/organization-settings/notification-preferences/default-recipients/:groupId(active|archived)';
const LONG_PATH_COMPONENT = 'RecipientSettings';

async function withLongListRows(fn: (p: Page, row: (id: string) => Locator) => Promise<void>) {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/home#Home' }, status: 'fine', author: 'reviewer' })).status, 201);
        await p.route('**/api/data', async (route) => {
          const data: PageData = await (await route.fetch()).json();
          for (const id of ['/home#Home', '/help#Help']) {
            const screen = data.map.screens.find((s) => s.id === id)!;
            Object.assign(screen, { path: LONG_PATH, component: LONG_PATH_COMPONENT, dead: id === '/home#Home' });
          }
          const importer = { title: 't', file: 'a.test.js', line: 1, source: 'a.js', format: 'vitest', depth: 'code', status: 'pass', testFile: 'a.test.js', via: ['a.js'] };
          data.tests.importers['/home#Home'] = [importer, importer];
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await fn(p, (id) => p.locator('#screen-list li', { hasText: LONG_PATH_COMPONENT }).nth(id === 'home' ? 0 : 1));
      }),
    ),
  );
}

const renderedLines = (locator: Locator) =>
  locator.evaluate((el) => {
    const lines = [];
    let top;
    for (const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); walker.nextNode(); ) {
      const node = walker.currentNode as Text;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect || /\s/.test(node.data[i])) continue;
        if (rect.top !== top) lines.push('');
        top = rect.top;
        lines[lines.length - 1] += node.data[i];
      }
    }
    return lines;
  });

test('in a browser, a long route in the screen list wraps only before a slash', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const lines = await renderedLines(row('help').locator('.name > span:first-child'));
    assert.ok(lines.length >= 3, `the path is long enough to wrap: ${lines}`);
    assert.equal(lines.join(''), LONG_PATH);
    assert.deepEqual(lines.filter((line) => !line.startsWith('/')), []);
  });
});

test('in a browser, the component name in the screen list stays on one line', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    for (const id of ['home', 'help']) assert.deepEqual(await renderedLines(row(id).locator('.name .muted')), [LONG_PATH_COMPONENT]);
  });
});

test('in a browser, the badges of a screen list row sit below the route and leave it the full row width', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const geometry = (r: Locator) =>
      r.evaluate((li) => {
        const box = (el: Element) => el.getBoundingClientRect();
        const style = getComputedStyle(li);
        return {
          content: box(li).width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          name: box(li.querySelector('.name')!),
          badgesTop: Math.min(...[...li.querySelectorAll('.chip, .count')].map((el) => box(el).top)),
        };
      });
    const crowded = await geometry(row('home'));
    const bare = await geometry(row('help'));
    assert.deepEqual(await row('home').locator('.chip, .count').allTextContents(), ['죽은 화면', '충분', '테스트 8', '불러옴 2']);
    assert.equal(crowded.name.width, bare.name.width);
    assert.ok(Math.abs(crowded.name.width - crowded.content) < 1, `${crowded.name.width} of ${crowded.content}`);
    assert.ok(crowded.badgesTop >= crowded.name.bottom && bare.badgesTop >= bare.name.bottom);

    const lines = await row('home').evaluate((li) => [...li.querySelectorAll('.badge-line')].map((line) => {
      const boxes = [...line.children].map((el) => el.getBoundingClientRect());
      return { texts: [...line.children].map((el) => el.textContent), tops: boxes.map((b) => b.top), bottom: Math.max(...boxes.map((b) => b.bottom)), widths: boxes.map((b) => b.width), gaps: boxes.slice(1).map((b, i) => b.left - boxes[i].right) };
    }));
    assert.deepEqual(lines.map((l) => l.texts), [['죽은 화면', '충분'], ['테스트 8', '불러옴 2']]);
    for (const line of lines) {
      assert.ok(line.widths.reduce((sum, w) => sum + w, 0) + 8 * (line.widths.length - 1) <= crowded.content, `the badges fit in one row width: ${line.widths} of ${crowded.content}`);
      assert.ok(Math.max(...line.tops) - Math.min(...line.tops) < 4, `the badges share one line: ${line.tops}`);
      assert.ok(line.gaps.every((gap) => Math.abs(gap - 8) < 0.5), `adjacent badges are 8px apart: ${line.gaps}`);
    }
    assert.ok(Math.min(...lines[1].tops) >= lines[0].bottom, `the counts sit under the chips: ${lines[1].tops} under ${lines[0].bottom}`);
  });
});

test('in a browser, a route that spans several segments in the screen list is found by in-page text search', { skip: browserMissing }, async () => {
  await withLongListRows(async (p) => {
    for (const text of ['/organization-settings/notification-preferences', '/default-recipients/:groupId(active|archived)']) {
      const found = await p.evaluate((t) => {
        getSelection()!.removeAllRanges();
        return { hit: (window as unknown as { find: (text: string) => boolean }).find(t), inList: document.getElementById('screen-list')!.contains(getSelection()!.anchorNode) };
      }, text);
      assert.deepEqual(found, { hit: true, inList: true }, text);
    }
  });
});

test('in a browser, a screen list row gives its full route and component as a tooltip and never scrolls the list sideways', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    assert.equal(await row('help').getAttribute('title'), `${LONG_PATH} ${LONG_PATH_COMPONENT}`);
    const list = await p.locator('#screen-list').evaluate((ul) => {
      ul.querySelector('.seg')!.append('x'.repeat(120));
      const section = ul.closest('section')!;
      return { scrollWidth: section.scrollWidth, clientWidth: section.clientWidth };
    });
    assert.equal(list.scrollWidth, list.clientWidth);
  });
});

test('in a browser, an over-wide route segment in the screen list is clipped at the row content edge, not drawn into the row padding', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const li = row('help');
    const strip = await li.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(el).paddingRight);
      return { x: box.right - pad, y: box.top, width: pad, height: box.height };
    });
    const before = await p.screenshot({ clip: strip });
    await li.locator('.seg').first().evaluate((el) => el.append('x'.repeat(120)));
    const after = await p.screenshot({ clip: strip });
    assert.ok(before.equals(after), 'the right padding of the row stays empty');
    assert.equal(await li.evaluate((el) => getComputedStyle(el).overflowX), 'visible');
  });
});

test('in a browser, the setting and role filters keep the screens that open only under one, and the chosen screen shows why', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=setting]');
        assert.deepEqual(await names(), ['/help', '/lab', '/lab/result', '/admin/report']);
        await p.uncheck('#left input[name=setting]');
        await p.check('#left input[name=role]');
        assert.deepEqual(await names(), ['/admin/member', '/admin/group', '/admin/audit', '/admin/report']);

        const access = p.locator('#center .access');
        await p.click('#screen-list li:has-text("/admin/report")');
        await openScreenInfo(p);
        assert.deepEqual((await p.locator('#center .open-needs .need').allTextContents()).map((t) => t.split(' ')[0]), ['역할', '설정']);
        await openLinkGroups(access);
        const fromHome = await access.locator('li:has-text("/home#Home")').innerText();
        assert.match(fromHome, /components\/SideMenu\.js:11/);
        assert.match(fromHome, /\['ADMIN', 'OWNER'\]\.indexOf\(session\['member\.role'\]\) > -1\s*역할/);
        assert.match(fromHome, /MENUS\.ADMIN\s*설정/);

        await p.uncheck('#left input[name=role]');
        await p.click('#screen-list li:has-text("/admin/member")');
        assert.match(await p.locator('#center .open-needs .route').innerText(), /isAdminRole\(memberRole\)\s*역할/);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.equal(await access.locator('details.link-group > summary').innerText(), '조건 없음 링크 1');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/lab#Lab")').innerText(), /링크를 건 화면에 필요한 것\s*설정/);
        assert.deepEqual(await access.locator('li:has-text("/lab#Lab") .from-kinds .chip').allTextContents(), ['설정']);
        await p.click('#screen-list li:has-text("/admin/audit")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/admin/member#AdminMember") .from-kinds .chip').allTextContents(), ['역할']);
        await p.click('#screen-list li:has-text("/help")');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/signin#SignIn")').innerText(), /globalSettings\.SYSTEM\.HELP_LINK_ENABLED \(openHelp 로 물려받음\)\s*설정/);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const bare = async (id: string) => (await tipLines(await screenBox(p, id))).filter((t) => / 필요$/.test(t));
        assert.deepEqual(await bare('/admin/report#AdminReport'), []);
        const labResult = await screenBox(p, '/lab/result#LabResult');
        assert.deepEqual(await bare('/lab/result#LabResult'), []);
        assert.deepEqual(await needTag(labResult), ['설정']);
        assert.deepEqual((await tipLines(labResult)).filter((t) => t.startsWith('필요한')), ['필요한 설정: SYSTEM.LAB_ENABLED 켬']);
        assert.deepEqual(await bare('/signin#SignIn'), []);
      }),
    ),
  );
});

const CHIP = '서버 대조 안 함';
const CHIP_EXPLANATION = '서버 API 목록(serverEndpoints)이 없거나 비어 있어 API 호출을 서버와 견주지 않았습니다. 목록을 채우고 duru rebuild 를 다시 하면 견줍니다.';

const withoutServerList = (fn: (config: Config, copy: string) => Promise<void>) => withRebuiltFixture({}, async (config, copy) => {
  fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
  fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
  rebuild(copy);
  await fn(config, copy);
});

test('in a browser, with no server API list the header line carries a 「서버 대조 안 함」 chip in both views and nothing sits above the header', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const box = (sel: string) => p.evaluate((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }, sel);
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.textContent('#meta .state'), CHIP);
        assert.match(await p.innerText('#meta'), /^화면 \d+ · 테스트 있는 화면 \d+ · 맵 .+ · 테스트 연결 .+서버 대조 안 함$/);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal(await p.evaluate(() => document.body.firstElementChild!.tagName), 'HEADER');
        assert.equal((await box('header')).top, 0);
        assert.equal((await box('main')).top, (await box('header')).bottom);
        assert.equal((await box('main')).bottom, 900);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 5);

        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '대조 안 함']);
        assert.equal(await p.locator('table.calls td.call .chip.v-unchecked').count(), 1);
        assert.deepEqual(await p.locator('#center .list-absent').allTextContents(), ['서버 목록 없음']);
        assert.match((await p.textContent('#center h2:has(.list-absent)'))!, /^API 호출 \d+ 서버 목록 없음$/);
        await p.locator('table.calls tr:has(.chip.v-unchecked) td.cell').first().click();
        assert.match((await p.textContent('#center .call-info'))!, /서버 대조 목록 없음\s*대조 안 함/);
        assert.deepEqual(await p.locator('#center .call-info .list-absent').allTextContents(), ['목록 없음']);
        assert.equal(await p.textContent('#center .call-info h2:has(.list-absent)'), '서버 대조 목록 없음');
        const text = () => p.innerText('body');
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal((await box('#flow-bar')).top, (await box('header')).bottom);
        assert.equal((await box('main')).bottom, 900);
        await (await screenBox(p, '/document/:tab#DocumentList')).click();
        assert.equal(await p.locator('#center table.calls td.call .chip.v-unchecked').count(), 1, 'the picked screen\'s calls say they were not compared');
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);
      })));
});

test('in a browser, the 「서버 대조 안 함」 chip explains itself on hover and on keyboard focus, and the popover hangs below the header and stays 16 px inside the window at wide and narrow windows', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const chip = p.locator('#meta .state');
        const tip = p.locator('#server-state-tip');
        assert.equal(await chip.evaluate((el) => el.tagName), 'BUTTON');
        assert.equal(await chip.getAttribute('type'), 'button');
        assert.equal(await chip.getAttribute('tabindex'), null);
        assert.equal(await chip.getAttribute('aria-describedby'), 'server-state-tip');
        assert.equal(await chip.getAttribute('title'), null);
        assert.equal(await tip.getAttribute('role'), 'note');
        assert.equal(await tip.textContent(), CHIP_EXPLANATION);
        assert.equal(await tip.isVisible(), false);

        const inside = async (width: number) => {
          const r = await tip.evaluate((el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, h: innerHeight }; });
          assert.ok(r.left >= 16 && r.right <= width - 16 && r.bottom <= r.h, JSON.stringify(r));
          const chipLeft = await chip.evaluate((el) => el.getBoundingClientRect().left);
          assert.ok(Math.abs(r.left - Math.max(16, Math.min(chipLeft, width - 16 - (r.right - r.left)))) < 1, `${JSON.stringify(r)} chip ${chipLeft}`);
          const header = await p.evaluate(() => document.querySelector('header')!.getBoundingClientRect().bottom);
          assert.ok(r.top >= header, `popover ${r.top} sits over the header ${header}`);
          assert.equal(await p.evaluate(() => { const b = document.getElementById('server-state-tip')!.getBoundingClientRect(); return document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)!.closest('#server-state-tip') !== null; }), true);
        };

        for (const width of [1440, 1100, 800, 600]) {
          await p.setViewportSize({ width, height: 900 });
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.hover();
          assert.equal(await tip.isVisible(), true, `hover at ${width}`);
          await inside(width);
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.focus();
          assert.equal(await tip.isVisible(), true, `focus at ${width}`);
          await inside(width);
          await p.evaluate(() => (document.activeElement as HTMLElement).blur());
          assert.equal(await tip.isVisible(), false);
        }

        await p.setViewportSize({ width: 1440, height: 900 });
        await p.focus('#view-story');
        await p.keyboard.press('Tab');
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'chip state');
        assert.equal(await tip.isVisible(), true);
      })));
});

test('in a browser, with a server API list the page has no chip, no 「목록 없음」 note and keeps the dead-screen filter', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#meta .state, #server-state-tip, #server-notice').count(), 0);
        assert.doesNotMatch((await p.textContent('#meta'))!, /서버 대조 안 함/);
        assert.equal(await p.locator('input[name=dead]').count(), 1);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 6);
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.equal(await p.locator('.list-absent').count(), 0);
        assert.doesNotMatch((await p.textContent('#center'))!, /목록 없음/);
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#meta .state').count(), 0);
      })));
});

test('in a browser, a 「죽은 화면」 filter left checked does not hide every screen once the map is rebuilt without a server API list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=dead]');
        const dead = await p.locator('#screen-list li').count();
        assert.ok(dead > 0 && dead < 11, String(dead));

        fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
        fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
        rebuild(copy);
        await p.click('#screen-list li >> nth=0');
        await p.click('#center tr:has-text("화면 전체")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("충분")');

        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#screen-list li').count(), 11);
      }));
  });
});
