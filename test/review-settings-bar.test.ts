import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withRebuiltFixture, withServer, withFakeApi, appSettings, SETTINGS_FILE, withSettingsFile, rewrite, rebuild, LIST_API, loginWithHeader, roleSettings, withPasswords, withPassword, ALL_PASSWORDS, browserMissing, toList, withPage, chooseScreen, settingRow } from './review-helpers.ts';

declare const state: any;
declare function pathValueKey(id: string, role: string | null): string;
declare function updateSettings(change: (list: object[]) => object[] | undefined): void;
const overridesOf = async (base: string) => (await (await fetch(`${base}/api/data`)).json()).app.settings.overrides;

test('in a browser, choosing a screen behind a setting opens the frame with the setting on, a toggle reloads it with the new value, and 「기본값으로」 puts every setting back', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/home');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.equal(await p.locator('#settings-bar').isHidden(), true);

            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            const bar = p.locator('#settings-bar');
            assert.match((await bar.getAttribute('class'))!, /overridden/);
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await lab.count(), 1);
            assert.match((await lab.getAttribute('class'))!, /changed/);
            assert.match((await lab.locator('button.on').textContent())!, /켜기/);
            assert.match((await lab.getAttribute('title'))!, /라우트 · \/home#Home 에서 오는 링크/);

            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch((await bar.getAttribute('class'))!, /overridden/);
            assert.doesNotMatch((await lab.getAttribute('class'))!, /changed/);
            assert.match((await lab.locator('button.on').textContent())!, /끄기/);

            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'true');
            assert.equal(await bar.isVisible(), true);
            assert.match((await bar.locator('.others').textContent())!, /SYSTEM\.LAB_ENABLED = true/);

            await bar.locator('button:has-text("기본값으로")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.equal(await bar.isHidden(), true);
            assert.ok(requests.every((r) => !r.includes('settings')));

            await chooseScreen(p, '/lab/result');
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('title'), '/lab#Lab 에서 물려받음');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting whose default the source does not show in full is written as the screen needs, even when the reviewer changed it and came back', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', '    LAB_ENABLED: window.LAB_DEFAULT ?? true,');
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}',
          '{globalSettings.SYSTEM.LAB_ENABLED ? null : <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact />}');
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rewrite(copy, 'build/app.js', 'LAB_ENABLED: false,', 'LAB_ENABLED: true,');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("false")').waitFor();
            const off = [{ path: ['SYSTEM', 'LAB_ENABLED'], value: false }];
            assert.deepEqual(await overridesOf(base), off);

            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);

            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);
          }),
        );
      }),
    ),
  );
});

test('in a browser, picking in the select the value a setting seems to have keeps it written when its section is not shown in full', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', "    LAB_ENABLED: false,\n    MODE: 'a',\n    ...window.EXTRA,");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', "{globalSettings.SYSTEM.MODE === 'a' ? <Route");
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const modeA = [{ path: ['SYSTEM', 'MODE'], value: 'a' }];
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
            const select = settingRow(p, 'SYSTEM.MODE').locator('select');
            assert.doesNotMatch((await select.locator('option').first().textContent())!, /"a"/);

            await select.selectOption({ index: 0 });
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            await select.selectOption('"a"');
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
          }),
        );
      }),
    ),
  );
});

test('in a browser, coming back to a screen whose setting the reviewer took away puts the unchanged value back instead of recording a change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.locator('input').uncheck();
            await frame.locator('#menu', { hasText: /^ADMIN_ARCHIVE$/ }).waitFor();

            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/admin/report');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch((await p.locator('#settings-bar').getAttribute('class'))!, /overridden/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed stays changed when the frame reopens the same screen as another account', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select.role').selectOption('account');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.waitForFunction(() => document.querySelector('#center iframe.app')?.getAttribute('src'));
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed on a screen with path variables stays changed when another role\'s values are loaded', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, settingsFile: SETTINGS_FILE, pathValues: { '/document/:id': { id: LIST_API } } } }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select.role').selectOption('role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen that falls back to its list screen sets what the list screen needs', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.match((await p.locator('#center .frame-bar').textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('class'))!, /changed/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, path values that arrive after the reviewer moved to the story list neither draw the screen over the story nor change settings', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ ...withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), storiesDir: 'example-stories' }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            await p.route('**/api/path-values?*', async (route) => {
              await held;
              await route.continue();
            });
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            await p.click('#left .views.side button:has-text("스토리")');
            release();
            await p.waitForFunction(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null))?.pending === false);
            const arrived = await p.evaluate(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null)));
            assert.deepEqual([arrived.errors, arrived.fallbackPath], [[], '/document/draft']);
            await p.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
            assert.equal(await p.textContent('#center h3'), '홈에서 개인 설정을 바꾼다');
            assert.equal(await p.locator('#center iframe').count(), 0);
            assert.deepEqual(await overridesOf(base), []);

            await p.click('#left .views.side button:has-text("화면")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen reached through a menu built from a settings list takes the menu entry out and back with 「목록에 넣기」', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_REPORT,ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), []);

            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            assert.match((await entry.textContent())!, /"ADMIN_REPORT".*목록에 넣기/);
            assert.equal(await entry.locator('input[type=checkbox]').isChecked(), true);
            assert.match((await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN').textContent())!, /기본값에 있음/);

            await entry.locator('input[type=checkbox]').uncheck();
            await frame.locator('#menu:has-text("ADMIN_ARCHIVE")').waitFor();
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], item: 'ADMIN_REPORT', value: false }]);
            assert.match((await entry.getAttribute('class'))!, /changed/);

            await entry.locator('input[type=checkbox]').check();
            await frame.locator('#menu:has-text("ADMIN_REPORT,ADMIN_ARCHIVE")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting in a section the app does not take from the settings file cannot be changed and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, settingsFile: { ...SETTINGS_FILE, merged: ['CUSTOM'] } } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.match((await lab.locator('.reason').textContent())!, /SYSTEM 섹션을 읽지 않아 바꿀 수 없습니다/);
            assert.equal(await lab.locator('button:has-text("켜기")').isDisabled(), true);
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting read through another settings root and a guard whose value cannot be worked out show why they cannot be changed, and the first link that can be satisfied is', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ settingsRoots: ['globalSettings', 'appSettings'], ...withSettingsFile(api) }, async (config, copy) => {
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{appSettings.SYSTEM.LAB_ENABLED && <Link');
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled !== false && <Link');
        fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = {};\n');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            const rows = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await rows.count(), 2);
            assert.equal(await rows.nth(0).locator('button:has-text("끄기")').isDisabled(), false);
            assert.match((await rows.nth(1).locator('.reason').textContent())!, /appSettings 로 읽는 설정이라/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);

            await chooseScreen(p, '/help');
            await p.waitForFunction(() => document.querySelectorAll('#settings-bar > .setting.changed').length === 1 && document.querySelector('#settings-bar .others'));
            const unreadable = settingRow(p, 'helpEnabled !== false');
            assert.match((await unreadable.locator('.reason').textContent())!, /같지 않음/);
            assert.match((await unreadable.getAttribute('title'))!, /\/document\/:id#DocumentDetail/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }, { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting the settings file already turns on shows as on, a need for it off writes false, and setting it back to the file value drops the change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{!helpEnabled && <Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/help');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#help:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }]);
            const help = settingRow(p, 'SYSTEM.HELP_LINK_ENABLED');
            assert.match((await help.getAttribute('class'))!, /changed/);
            assert.match((await help.locator('button.on').textContent())!, /끄기/);

            await help.locator('button:has-text("켜기")').click();
            await frame.locator('#help:has-text("true")').waitFor();
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), []);
            assert.match((await help.locator('button.on').textContent())!, /켜기/);

            fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = { SYSTEM: { HELP_LINK_ENABLED: document.title !== null } };\n');
            await p.reload();
            await toList(p);
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .file-error');
            assert.match((await p.locator('#settings-bar .file-error').textContent())!, /맵의 기본값으로 판단합니다.*document/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a list inside a default the source does not show in full cannot be changed unless the settings file sets it, and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},");
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.waitFor();
            assert.match((await entry.locator('.reason').textContent())!, /SYSTEM\.MAIN_MENU 기본값을 소스에서 다 읽지 못해/);
            assert.equal(await entry.locator('input[type=checkbox]').isDisabled(), true);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting that only has to be present is not met by an empty default', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,\n', "    LAB_ENABLED: false,\n    BANNER: '',\n");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', '{globalSettings.SYSTEM.BANNER ? <Route');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const banner = settingRow(p, 'SYSTEM.BANNER');
            await banner.waitFor();
            assert.doesNotMatch((await banner.textContent())!, /기본값에 있음/);
            assert.match((await banner.locator('.reason').textContent())!, /넣을 수 없습니다/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a failed settings change is shown until another screen is chosen', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.route('**/api/settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'settings store down' }));
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .error:has-text("설정을 바꾸지 못했습니다")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.unroute('**/api/settings');

            await chooseScreen(p, '/admin/report');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST').waitFor();
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a settings change that throws is shown and does not stop the changes after it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();

            await p.evaluate(() => updateSettings(() => {
              throw new Error('change failed');
            }));
            await p.waitForSelector('#settings-bar .error:has-text("change failed")');
            await p.evaluate(() => updateSettings((list) => [...list, { path: ['SYSTEM', 'LAB_ENABLED'], value: true }]));
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
          }),
        ),
      ),
    ),
  );
});
