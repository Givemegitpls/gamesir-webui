// Verifies the generated udev commands: quoting is safe and the echo variant
// really produces the intended rule file.
// Run: node tools/test-udev.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUdevScript, ruleLine, sanitizeGroup } from '../web/js/udev.js';

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
};

const defaultLine = 'KERNEL=="hidraw*", ATTRS{idVendor}=="3537", MODE="0660", GROUP="input", TAG+="uaccess"';
check('default rule line', ruleLine() === defaultLine, ruleLine());
check('no quotes that break echo', !ruleLine().includes("'"));
check(
  'uaccess-only variant',
  ruleLine({ groupId: '' }) === 'KERNEL=="hidraw*", ATTRS{idVendor}=="3537", TAG+="uaccess"',
  ruleLine({ groupId: '' }),
);
check('alternative group', ruleLine({ groupId: 'uucp' }).includes('GROUP="uucp"'));

// untrusted group strings must not reach the shell
check('sanitize rejects injection', sanitizeGroup("input'; rm -rf /") === null);
check('sanitize treats empty as no group', sanitizeGroup('') === '');
check('injection does not leak', !ruleLine({ groupId: "input'; rm -rf /" }).includes('rm -rf'));
check('injection falls back to the default group', ruleLine({ groupId: "input'; rm -rf /" }).includes('GROUP="input"'));
check('sanitize keeps plain names', sanitizeGroup('plugdev') === 'plugdev');

// execute the generated command against a temp path and compare the result
const dir = mkdtempSync(join(tmpdir(), 'gamesir-udev-'));
const target = join(dir, '99-test.rules');
const script = buildUdevScript({ groupId: 'input', rulePath: target, useSudo: false });
execFileSync('sh', ['-c', script.install], { stdio: 'pipe' });
const written = readFileSync(target, 'utf8');
check('install command writes the exact line', written === `${defaultLine}\n`, JSON.stringify(written.slice(0, 60)));

const alt = buildUdevScript({ groupId: "evil'; touch /tmp/pwned; '", rulePath: target, useSudo: false });
execFileSync('sh', ['-c', alt.install], { stdio: 'pipe' });
check('injected group falls back to input', readFileSync(target, 'utf8').includes('GROUP="input"'));

check('reload touches udevadm', /udevadm control --reload-rules/.test(script.reload) && /udevadm trigger/.test(script.reload));
check('remove deletes the rule path', script.remove.includes(`rm ${target}`));
check('chmod fallback matches the vendor', script.chmod.includes('idVendor') && script.chmod.includes('3537'));
check('oneShot bundles install+reload+verify', script.oneShot.split('\n').length === 3);

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
