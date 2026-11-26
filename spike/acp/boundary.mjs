// The boundary of the permission experiment: which tool call may be allowed
// automatically. Disposable spike code — it does not touch production code.
//
// The rule is deliberately strict: a call is allowed only when every path it
// names lies inside the scratch roots of the run. A call that names no path at
// all cannot be checked and is refused as well.

import { lstatSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every absolute path the call names.
 *
 * The values of the call come first: a write names its target in `rawInput` or
 * in `locations`, and every field of the call is read, not only those two. The
 * whole call is read as text as well: a path that is mentioned inside a string
 * (a command, a pattern) is a target too.
 */
export function toolCallPaths(toolCall) {
  const call = toolCall ?? {};
  const paths = [];
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('/')) paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(call);
  // The call is read as text as well: a path inside a string (a command, a
  // pattern) is a target too. A token counts as a path when it starts where a
  // path can start — after a quote, a space, a bracket. The slash of a mime
  // type (`text/plain`) stands in the middle of a word and is no path; the
  // slash of a relative path (`node_modules/.bin/x`) is no path either.
  const text = String(JSON.stringify(call));
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])(\/[^\s"'`,)]+)/g)) {
    const token = match[1];
    // the `//` of a url is not a path of the machine
    if (token.startsWith('//')) continue;
    paths.push(token);
  }
  return paths;
}

/**
 * The real path of a target: every symbolic link on the way is followed, so a
 * link inside a root that points outside of it is seen as what it points to.
 *
 * The links are read with `lstat`, not with `exists`: a link whose target does
 * not exist yet is a link all the same, and a write through it lands outside of
 * the root.
 *
 * A chain of links is followed as a whole: a link that points at another link
 * is not the end of the walk — the second link is followed as well, otherwise
 * a link inside a root that points at a link that points outside of it would
 * look like a path inside the root.
 */
export function realTarget(path) {
  let pending = resolve(path).split('/').filter(Boolean);
  let resolved = '/';
  // a loop of links is not a path that can be checked — the walk gives up and
  // the result matches no root
  for (let hop = 0; hop < 40; hop++) {
    if (pending.length === 0) return resolved;
    const part = pending.shift();
    const next = resolve(resolved, part);
    let link = null;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // the path does not exist (yet): it is kept as it is
      link = null;
    }
    if (link === null) {
      resolved = next;
      continue;
    }
    // the link is replaced by its target, and the walk starts again there
    const target = link.startsWith('/') ? resolve(link) : resolve(resolved, link);
    pending = [...target.split('/').filter(Boolean), ...pending];
    resolved = '/';
  }
  return '\u0000';
}

/**
 * The kinds of the tool calls whose effect is bounded by the paths they name:
 * they read, write, move or delete files and nothing else. Every other kind —
 * a shell command, a network operation, an unknown one — can reach anything,
 * so it is never approved automatically.
 */
const FILESYSTEM_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search']);

/**
 * Whether a tool call stays inside the scratch space of the run.
 *
 * Only a filesystem operation may be approved automatically, and only when
 * every path it names lies inside one of the roots. A path that climbs out of
 * them (`../`) is refused. A call that names no path at all cannot be checked
 * — it is refused as well, because an operation without a known target
 * (a command, a network call) can reach anything.
 */
export function insideBoundary(toolCall, roots) {
  const call = toolCall ?? {};
  // a relative path that climbs out of the scratch space
  if (/(^|[\s"'`(=/])\.\.[/\\]/.test(String(JSON.stringify(call)))) return false;
  // the effect of a shell command or of a network call is not bounded by the
  // paths it mentions: a command can read a file of the scratch space and
  // send it away. Only a filesystem operation is approved automatically.
  if (!FILESYSTEM_KINDS.has(call.kind)) return false;
  const paths = toolCallPaths(call);
  // a pathless call names no target that could be checked
  if (paths.length === 0) return false;
  const realRoots = roots.map((root) => realTarget(root));
  return paths.every((path) => {
    const target = realTarget(path);
    return realRoots.some((root) => target === root || target.startsWith(`${root}/`));
  });
}
