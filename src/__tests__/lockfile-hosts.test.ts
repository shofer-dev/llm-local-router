/**
 * Guard: the committed npm lockfiles name only the canonical public registry.
 *
 * npm writes each package's `resolved` tarball URL from the registry the
 * installing machine was configured with, so an install on a host whose npm
 * points at the platform's Nexus NodePort commits
 * `http://localhost:30084/repository/npm-proxy/...`. That URL is dead inside an
 * image build or a CI pod (`localhost` is the container itself), and the
 * failure is quiet. `https://registry.npmjs.org/` is the host-neutral form: npm
 * swaps it for `npm_config_registry` at install time, so Nexus is still used.
 * `integrity` is a content hash and is not inspected.
 *
 * If this fails after an `npm install` on a host, rewrite the offending prefix
 * to https://registry.npmjs.org/ (e.g. with sed) before committing. A value
 * with no scheme (a workspace link) names no host and is allowed.
 *
 * Same contract as scripts/check-npm-lockfiles.sh in the parent repository.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const CANONICAL = 'https://registry.npmjs.org/';

/** Every `resolved` value in a lockfile's text that is a URL outside the canonical registry. */
export function offendingResolved(lockfileText: string): string[] {
    const out: string[] = [];
    for (const m of lockfileText.matchAll(/"resolved":\s*"([^"]*)"/g)) {
        const value = m[1];
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !value.startsWith(CANONICAL)) {
            out.push(value);
        }
    }
    return out;
}

const ROOT = path.resolve(__dirname, '..', '..');

describe('offendingResolved', () => {
    const lock = (...resolved: string[]): string =>
        JSON.stringify({ packages: Object.fromEntries(resolved.map((r, i) => [`node_modules/p${i}`, { resolved: r }])) }, null, 2);

    it('accepts canonical registry URLs and scheme-less workspace links', () => {
        assert.deepEqual(offendingResolved(lock(`${CANONICAL}a/-/a-1.tgz`, '../libs/x')), []);
    });

    it('refuses a loopback NodePort, an in-cluster Nexus, an unknown host and a git URL', () => {
        const bad = [
            'http://localhost:30084/repository/npm-proxy/a/-/a-1.tgz',
            'http://127.0.0.1:30084/repository/npm-proxy/a/-/a-1.tgz',
            'http://nexus.justceo.svc.cluster.local:8081/repository/npm-proxy/a/-/a-1.tgz',
            'https://npm.example.org/a/-/a-1.tgz',
            'git+ssh://git@github.com/x/y.git',
        ];
        assert.deepEqual(offendingResolved(lock(...bad, `${CANONICAL}ok/-/ok-1.tgz`)), bad);
    });
});

describe('committed lockfiles', () => {
    for (const rel of ['package-lock.json', path.join('webview-ui', 'package-lock.json')]) {
        it(`${rel} names only ${CANONICAL}`, () => {
            const bad = offendingResolved(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            assert.equal(bad.length, 0, `${bad.length} resolved URL(s) outside ${CANONICAL}, first: ${bad[0]}`);
        });
    }
});
