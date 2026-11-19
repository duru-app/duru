import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression } from '@babel/types';
import { requestFunctionFile } from './api-calls.ts';
import { keyName, lookupConstant, memberChain, UNKNOWN } from './client.ts';
import type { BodyOption, ModuleEndpoint, ModuleFunction } from './client.ts';
import type { nameFollower, Origin } from './follow-names.ts';
import { parseSource } from './parse.ts';
import { sagaReader } from './saga-requests.ts';
import { screenInputReader } from './screen-inputs.ts';
import { screenRequestReader } from './screen-requests.ts';
import { cleanAddress, pathOnSite } from './sent-address.ts';
import type { sourceValueReader } from './source-values.ts';

type NameNode = { name?: string; value?: string };

type SourceValues = Awaited<ReturnType<typeof sourceValueReader>>;

interface Reading extends Pick<SourceValues, 'constants' | 'calledFiles' | 'parse' | 'programFile' | 'evaluate' | 'constInit' | 'objectLiteral' | 'propertyKey'> {
  config: any;
  resolve: (fromFile: string, spec: string) => string | null;
  follower: Pick<ReturnType<typeof nameFollower>, 'declaration' | 'origin'>;
}

const traverse = _traverse.default ?? _traverse;

export function clientCallReader({ config, resolve, follower, constants, calledFiles, parse, programFile, evaluate, constInit, objectLiteral, propertyKey }: Reading) {
  const isUseState = (callee: CallExpression['callee']) =>
    (callee.type === 'Identifier' && callee.name === 'useState') || (callee.type === 'MemberExpression' && !callee.computed && (callee.property as Identifier).name === 'useState');

  function isToggle(value: NodePath) {
    if (value.isBooleanLiteral()) return true;
    if (!value.isIdentifier()) return false;
    const binding = value.scope.getBinding(value.node.name);
    if (binding?.kind !== 'const' || !binding.path.isVariableDeclarator()) return false;
    const { id, init } = binding.path.node;
    if (id.type === 'Identifier') return init?.type === 'BooleanLiteral';
    return (
      id.type === 'ArrayPattern' &&
      id.elements[0]?.type === 'Identifier' &&
      id.elements[0].name === value.node.name &&
      init?.type === 'CallExpression' &&
      isUseState(init.callee) &&
      init.arguments[0]?.type === 'BooleanLiteral'
    );
  }

  const mayOverride = (later: NodePath<any>, key: string | undefined) => later.isSpreadElement() || later.node.computed || keyName(later.node) === key;
  function overridden(props: NodePath<any>[], i: number) {
    const key = propertyKey(props[i]);
    return props.slice(i + 1).some((later) => mayOverride(later, key));
  }

  const assignedKey = ({ computed, property }: MemberExpression) => (!computed ? (property as Identifier).name : property.type === 'StringLiteral' ? property.value : undefined);

  // 본문이 거쳐 온 const 마다, 호출보다 위에서 `body.key = …` 나 `body['key'] = …` 로 대입한 자리
  function assignments(nodePath: NodePath<any>, before: number) {
    const found: { key: string; value: NodePath; start: number; line: number }[] = [];
    const seen = new Set<Binding>();
    for (let at: NodePath<any> | null = nodePath; at?.isIdentifier(); ) {
      const binding = at.scope.getBinding(at.node.name);
      at = constInit(at, at.node.name, seen);
      if (!at) break;
      for (const ref of binding!.referencePaths) {
        const assign = ref.parentPath!.parentPath!;
        if (ref.key !== 'object' || !ref.parentPath!.isMemberExpression() || ref.parentPath.key !== 'left') continue;
        if (!assign.isAssignmentExpression({ operator: '=' }) || assign.node.start! > before) continue;
        const key = assignedKey(ref.parentPath.node);
        if (key !== undefined) found.push({ key, value: assign.get('right'), start: assign.node.start!, line: assign.node.loc!.start.line });
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }

  function bodyOptions(callPath: NodePath<CallExpression>) {
    const options: BodyOption[] = [];
    for (const arg of callPath.get('arguments')) {
      const obj = objectLiteral(arg);
      if (!obj) continue;
      const outer = obj.get('properties');
      const at = outer.findLastIndex((p) => config.bodyArgKeys.includes(propertyKey(p)));
      if (at >= 0 && overridden(outer, at)) continue;
      const written = at >= 0 ? outer[at].get('value') as NodePath : arg;
      const body = objectLiteral(written);
      if (!body) continue;
      const props = body.get('properties');
      const found: BodyOption[] = [];
      props.forEach((prop, i) => {
        const key = propertyKey(prop);
        if (key !== undefined && isToggle(prop.get('value') as NodePath) && !overridden(props, i)) found.push({ key, line: prop.node.loc!.start.line });
      });
      for (const { key, value, line } of assignments(written, callPath.node.start!)) {
        if (isToggle(value) && !found.some((o) => o.key === key)) found.push({ key, line });
      }
      options.push(...found);
    }
    return options;
  }

  function extractApiModule(file: string) {
    const sentUrl = (url: unknown) => {
      if (typeof url !== 'string') return (url ?? null) as string | null;
      const clean = cleanAddress(url);
      return pathOnSite(clean, config.app?.server ?? null, UNKNOWN) ?? clean;
    };
    const { ast } = parseSource(file);
    programFile.set(ast.program, file);
    const fns: Record<string, ModuleFunction> = {};
    traverse(ast, {
      ExportNamedDeclaration(exp) {
        const decl = exp.get('declaration');
        if (!decl.isVariableDeclaration()) return;
        for (const d of decl.get('declarations')) {
          const name = (d.node.id as Identifier).name;
          const endpoints: ModuleEndpoint[] = [];
          const delegates = new Set<string>();
          d.traverse({
            ObjectExpression(obj) {
              const keys = obj.node.properties.map((p) => (p as { key?: NameNode }).key?.name ?? (p as { key?: NameNode }).key?.value);
              if (!keys.includes('URL')) return;
              const value = evaluate(obj);
              endpoints.push({ method: value?.METHOD ?? null, url: sentUrl(value?.URL), line: obj.node.loc!.start.line });
            },
            MemberExpression(m) {
              if (m.parentPath.isMemberExpression({ object: m.node })) return;
              const value = lookupConstant(constants, memberChain(m.node));
              if (value && typeof value === 'object' && 'URL' in value) {
                endpoints.push({ method: value.METHOD ?? null, url: sentUrl(value.URL), line: m.node.loc!.start.line });
              }
            },
            CallExpression(c) {
              if (c.node.callee.type === 'Identifier') delegates.add(c.node.callee.name);
            },
          });
          fns[name] = { file: path.relative(config.srcRoot, file), line: d.node.loc!.start.line, endpoints, delegates: [...delegates] };
        }
      },
    });
    for (const fn of Object.values(fns)) {
      for (const callee of fn.delegates!) {
        if (fns[callee] && fns[callee] !== fn) fn.endpoints.push(...fns[callee].endpoints.map((e) => ({ ...e, via: callee })));
      }
      delete fn.delegates;
      const seen = new Set();
      fn.endpoints = fn.endpoints.filter((e) => {
        const key = JSON.stringify([e.method, e.url, e.via ?? null]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return fns;
  }

  const sagas = sagaReader({ parse, resolve, declaration: follower.declaration });
  const origins = new Map<string, Origin | null>();
  const calledOrigin = (file: string | null | undefined, name: string) => {
    const key = `${file}\0${name}`;
    if (!origins.has(key)) origins.set(key, follower.origin(file, name, (f) => calledFiles.has(f)));
    return origins.get(key);
  };

  const requestFile = requestFunctionFile(config, resolve);
  const requestImports = new Map<string, boolean>();
  const screenRequests = screenRequestReader({
    requestFunction: config.requestFunction,
    evaluate,
    objectLiteral,
    server: config.app?.server ?? null,
    isRequestFunction(file, spec, name) {
      const { import: from, name: exported } = config.requestFunction;
      if (!from.startsWith('.') && spec === from && name === exported) return true;
      if (!requestFile) return false;
      const resolved = resolve(file, spec);
      const key = `${resolved}\0${name}`;
      if (!requestImports.has(key)) requestImports.set(key, follower.origin(resolved, name, (f) => f === requestFile)?.name === exported);
      return requestImports.get(key)!;
    },
  });

  const screenInputs = config.requestFunction?.body ? screenInputReader({ srcRoot: config.srcRoot, resolve }) : null;

  return { bodyOptions, extractApiModule, sagas, calledOrigin, requestFile, screenRequests, screenInputs };
}
