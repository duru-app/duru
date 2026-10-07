import type { RequestOptions } from './request';

type Send = (options: RequestOptions) => Promise<unknown>;

class BaseApi {
  constructor(protected readonly send: Send) {}

  protected search(query: string) {
    return this.send({ endpoint: { method: 'GET', path: '' }, url: `/internal/v2/note/search?q=${query}` });
  }

  protected helper() {
    return this.send({ endpoint: { method: 'GET', path: '' }, url: '/internal/v2/note/helper' });
  }
}

export class NoteApi extends BaseApi {
  private base = '';

  public search(query: string) {
    return super.search(query);
  }

  setBase(base: string) {
    this.base = base;
  }

  loadNotes() {
    return this.send({ endpoint: { method: 'GET', path: '' }, url: `${this.base}/internal/v2/note/list` });
  }

  loadNumbered({ id }: { id: number }) {
    if (typeof id !== 'number') return null;
    return this.send({ endpoint: { method: 'GET', path: '' }, url: `/internal/v2/note/${id}` });
  }

  fetchItems({ count }: { count: number }) {
    if (typeof count !== 'number') throw new Error('count must be a number');
    const sent = [];
    for (let item = 0; item < count; item++) sent.push(this.send({ endpoint: { method: 'GET', path: '' }, url: `/internal/v2/note/item/${item}` }));
    return Promise.all(sent);
  }

  sendForever() {
    for (;;) this.send({ endpoint: { method: 'GET', path: '' }, url: '/internal/v2/note/forever' });
  }

  fetchPages({ pages }: { pages: number }) {
    const sent = [];
    for (let page = 0; page < pages; page++) sent.push(this.send({ endpoint: { method: 'GET', path: '' }, url: `/internal/v2/note/page/${page}` }));
    return Promise.all(sent);
  }
}
