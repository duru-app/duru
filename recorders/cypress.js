let steps = [];

Cypress.on('url:changed', (url) => {
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
  const folder = (typeof Cypress.expose === 'function' ? Cypress.expose('duruVisitRecords') : Cypress.env('duruVisitRecords')) || 'cypress/visits';
  cy.writeFile(`${folder}/${Cypress.spec.relative}/${fileSafe(name)}.json`, { steps: [...steps] }, { log: false });
});

function withoutTags(title) {
  return title.split(/\s+/).filter((word) => word && !/^@\S/.test(word)).join(' ');
}

function fileSafe(name) {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').trim();
}
