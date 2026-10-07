import { noteApi } from './shared';

export default function Notes() {
  return <main onLoad={() => noteApi.loadNotes()} />;
}
