import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PAGE_PARTS } from '../src/review.ts';

const PAGE_DIR = path.join(import.meta.dirname, '../src/review-page');
const CONFIG = path.join(import.meta.dirname, '../tsconfig.review-page.json');

interface Part {
  file: string;
  text: string;
}

function pageConfig() {
  const parsed = ts.getParsedCommandLineOfConfigFile(CONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  assert.deepEqual(parsed!.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), []);
  assert.ok(parsed!.fileNames.length > 0);
  return parsed!;
}

const errorsIn = (program: ts.Program, source: ts.SourceFile) => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
const programErrors = (program: ts.Program) => [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => errorText('tsconfig.review-page.json', d));
const errorText = (where: string, d: ts.Diagnostic) => `${where} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;

function pageErrors() {
  const { fileNames, options } = pageConfig();
  const program = ts.createProgram(fileNames, options);
  return [...programErrors(program), ...program.getSourceFiles()
    .filter((source) => path.dirname(source.fileName) === PAGE_DIR)
    .flatMap((source) => errorsIn(program, source).map((d) => {
      const { line } = source.getLineAndCharacterOfPosition(d.start!);
      return errorText(`${path.basename(source.fileName)}:${line + 1}`, d);
    }))];
}

function joinedErrors(parts: Part[]) {
  const { options } = pageConfig();
  const joined = path.join(PAGE_DIR, 'joined.js');
  const starts: number[] = [];
  let text = '';
  for (const part of parts) {
    starts.push(text.split('\n').length - 1);
    text += part.text;
  }
  const host = ts.createCompilerHost(options);
  const sourceOf = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === joined ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) : sourceOf(name, ...rest));
  const program = ts.createProgram([joined], options, host);
  const source = program.getSourceFile(joined)!;
  return [...programErrors(program), ...errorsIn(program, source).map((d) => {
    const { line } = source.getLineAndCharacterOfPosition(d.start!);
    const i = starts.findLastIndex((start) => start <= line);
    return errorText(`${parts[i].file}:${line - starts[i] + 1}`, d);
  })];
}

test('the review page scripts have no type errors', () => {
  assert.deepEqual(pageErrors(), []);
});

test('the review page scripts joined in the order the server sends them have no type errors', () => {
  const parts = PAGE_PARTS.filter((part) => part.endsWith('.js')).map((file) => ({ file, text: fs.readFileSync(path.join(PAGE_DIR, file), 'utf8') }));
  assert.deepEqual(joinedErrors(parts), []);
});

test('the joined check reports a constant used at the top level of a file before a later file defines it, at the file and line of the use', () => {
  const errors = joinedErrors([
    { file: 'script-first.js', text: 'const early = 1;\nfunction later() {\n  return LIMIT;\n}\nconst doubled = LIMIT * 2;\n' },
    { file: 'script-second.js', text: 'const LIMIT = 3;\n' },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^script-first\.js:5 TS2448 /);
});
