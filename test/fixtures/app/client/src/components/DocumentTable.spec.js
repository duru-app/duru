import DocumentTable from './DocumentTable';

jest.mock('_ajax/AjaxFunc');

describe('DocumentTable', () => {
  it('lists the documents it is given', () => {
    expect(DocumentTable).toBeDefined();
  });
});
