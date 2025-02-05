import { lang, lexer, parser, query as q } from 'good-enough-parser';
import hasha from 'hasha';
import * as memCache from '../../../util/cache/memory';
import { supportedRulesRegex } from './rules/index';
import type {
  ArrayFragment,
  Fragment,
  FragmentData,
  NestedFragment,
  RecordFragment,
} from './types';

interface Ctx {
  readonly source: string;
  stack: NestedFragment[];
  recordKey?: string;
}

function emptyCtx(source: string): Ctx {
  return {
    source,
    stack: [
      {
        type: 'array',
        value: source,
        offset: 0,
        children: [],
      },
    ],
  };
}

function currentFragment(ctx: Ctx): NestedFragment {
  const deepestFragment = ctx.stack[ctx.stack.length - 1];
  return deepestFragment;
}

function extractTreeValue(
  source: string,
  tree: parser.Tree,
  offset: number
): string {
  if (tree.type === 'wrapped-tree') {
    const { endsWith } = tree;
    const to = endsWith.offset + endsWith.value.length;
    return source.slice(offset, to);
  }

  // istanbul ignore next
  return '';
}

/**
 * Matches key-value pairs:
 * - `tag = "1.2.3"`
 * - `name = "foobar"`
 * - `deps = ["foo", "bar"]`
 **/
const kwParams = q
  .sym<Ctx>((ctx, { value: recordKey }) => ({ ...ctx, recordKey }))
  .op('=')
  .alt(
    // string
    q.str((ctx, { offset, value }) => {
      const frag = currentFragment(ctx);
      if (frag.type === 'record' && ctx.recordKey) {
        const key = ctx.recordKey;
        frag.children[key] = { type: 'string', value, offset };
      }
      return ctx;
    }),
    // array of strings
    q.tree({
      type: 'wrapped-tree',
      maxDepth: 1,
      preHandler: (ctx, tree) => {
        const parentRecord = currentFragment(ctx) as RecordFragment;
        if (
          parentRecord.type === 'record' &&
          ctx.recordKey &&
          tree.type === 'wrapped-tree'
        ) {
          const key = ctx.recordKey;
          parentRecord.children[key] = {
            type: 'array',
            value: '',
            offset: tree.startsWith.offset,
            children: [],
          };
        }
        return ctx;
      },
      search: q.str<Ctx>((ctx, { value, offset }) => {
        const parentRecord = currentFragment(ctx);
        if (parentRecord.type === 'record' && ctx.recordKey) {
          const key = ctx.recordKey;
          const array = parentRecord.children[key];
          if (array.type === 'array') {
            array.children.push({ type: 'string', value, offset });
          }
        }
        return ctx;
      }),
      postHandler: (ctx, tree) => {
        const parentRecord = currentFragment(ctx);
        if (
          parentRecord.type === 'record' &&
          ctx.recordKey &&
          tree.type === 'wrapped-tree'
        ) {
          const key = ctx.recordKey;
          const array = parentRecord.children[key];
          if (array.type === 'array') {
            array.value = extractTreeValue(ctx.source, tree, array.offset);
          }
        }
        return ctx;
      },
    })
  )
  .handler((ctx) => {
    delete ctx.recordKey;
    return ctx;
  });

/**
 * Matches rule signature:
 *   `git_repository(......)`
 *                  ^^^^^^^^
 *
 * @param search something to match inside parens
 */
function ruleCall(search: q.QueryBuilder<Ctx>): q.QueryBuilder<Ctx> {
  return q.tree({
    type: 'wrapped-tree',
    maxDepth: 1,
    search,
    postHandler: (ctx, tree) => {
      const frag = currentFragment(ctx);
      if (frag.type === 'record' && tree.type === 'wrapped-tree') {
        frag.value = extractTreeValue(ctx.source, tree, frag.offset);
      }

      ctx.stack.pop();
      const parentFrag = currentFragment(ctx);
      if (parentFrag.type === 'array') {
        parentFrag.children.push(frag);
      }

      return ctx;
    },
  });
}

function ruleStartHandler(ctx: Ctx, { value, offset }: lexer.Token): Ctx {
  const parentFragment = currentFragment(ctx);
  if (parentFragment.type === 'array') {
    ctx.stack.push({
      type: 'record',
      value: '',
      offset,
      children: {},
    });
  }

  return ctx;
}

function ruleNameHandler(ctx: Ctx, { value, offset }: lexer.Token): Ctx {
  const ruleFragment = currentFragment(ctx);
  if (ruleFragment.type === 'record') {
    ruleFragment.children['rule'] = { type: 'string', value, offset };
  }

  return ctx;
}

/**
 * Matches regular rules:
 * - `git_repository(...)`
 * - `go_repository(...)`
 */
const regularRule = q
  .sym<Ctx>(supportedRulesRegex, (ctx, token) =>
    ruleNameHandler(ruleStartHandler(ctx, token), token)
  )
  .join(ruleCall(kwParams));

/**
 * Matches "maybe"-form rules:
 * - `maybe(git_repository, ...)`
 * - `maybe(go_repository, ...)`
 */
const maybeRule = q
  .sym<Ctx>('maybe', ruleStartHandler)
  .join(
    ruleCall(
      q.alt(
        q.begin<Ctx>().sym(supportedRulesRegex, ruleNameHandler).op(','),
        kwParams
      )
    )
  );

const rule = q.alt<Ctx>(maybeRule, regularRule);

const query = q.tree<Ctx>({
  type: 'root-tree',
  maxDepth: 16,
  search: rule,
});

function getCacheKey(input: string): string {
  const hash = hasha(input);
  return `bazel-parser-${hash}`;
}

const starlark = lang.createLang('starlark');

export function parse(input: string): ArrayFragment | null {
  const cacheKey = getCacheKey(input);

  const cachedResult = memCache.get<ArrayFragment | null>(cacheKey);
  // istanbul ignore if
  if (cachedResult === null || cachedResult) {
    return cachedResult;
  }

  let result: ArrayFragment | null = null;
  const parsedResult = starlark.query(input, query, emptyCtx(input));
  if (parsedResult) {
    const rootFragment = parsedResult.stack[0];
    if (rootFragment.type === 'array') {
      result = rootFragment;
    }
  }

  memCache.set(cacheKey, result);
  return result;
}

export function extract(fragment: Fragment): FragmentData {
  if (fragment.type === 'string') {
    return fragment.value;
  }

  if (fragment.type === 'record') {
    const { children } = fragment;
    const result: Record<string, FragmentData> = {};
    for (const [key, value] of Object.entries(children)) {
      result[key] = extract(value);
    }
    return result;
  }

  return fragment.children.map(extract);
}
