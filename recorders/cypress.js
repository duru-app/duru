let steps = [];

Cypress.on('url:changed', (address) => {
  const url = address.replace(/[?#].*$/s, '');
  if (/^https?:/i.test(url) && steps.at(-1)?.url !== url) steps.push({ url });
});

beforeEach(() => {
  steps = [];
});

afterEach(function () {
  if (this.currentTest.state !== 'passed' || !steps.length) return;
  const titles = this.currentTest.titlePath();
  const shown = titles.map(withoutTags).filter(Boolean);
  const name = (shown.length ? shown : titles).join(' -- ');
  const folder = setting('duruVisitRecords') || 'cypress/visits';
  cy.writeFile(`${folder}/${Cypress.spec.relative}/${fileSafe(name)}.json`, { steps }, { log: false });
});

function setting(key) {
  const exposed = typeof Cypress.expose === 'function' ? Cypress.expose(key) : undefined;
  if (exposed !== undefined) return exposed;
  try {
    return Cypress.env(key);
  } catch {
    return undefined;
  }
}

function withoutTags(title) {
  return title.split(/\s+/).filter((word) => word && !/^@\S/.test(word)).join(' ');
}

function fileSafe(name) {
  let kept = '';
  let bytes = 0;
  for (const character of name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').trim()) {
    const point = character.codePointAt(0);
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > 200) break;
    kept += character;
  }
  return kept.trim();
}
