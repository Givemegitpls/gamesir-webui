// Generates the udev commands shown on the page, so the user can copy-paste
// them without opening the repository. Kept dependency-free and testable.

export const RULE_PATH = '/etc/udev/rules.d/70-gamesir.rules';
export const VENDOR = '3537';

// Only sane group names may reach the shell. Returns '' when no group is
// wanted (uaccess-only) and null when the value is not usable at all.
export function sanitizeGroup(groupId) {
  if (groupId === '' || groupId === null || groupId === undefined) return '';
  return typeof groupId === 'string' && /^[a-z0-9_-]{1,32}$/.test(groupId) ? groupId : null;
}

export function ruleLine({ groupId = 'input' } = {}) {
  const raw = sanitizeGroup(groupId);
  const group = raw === null ? 'input' : raw; // garbage falls back to the default
  const parts = ['KERNEL=="hidraw*"', `ATTRS{idVendor}=="${VENDOR}"`];
  if (group) parts.push('MODE="0660"', `GROUP="${group}"`);
  parts.push('TAG+="uaccess"');
  return parts.join(', ');
}

export function buildUdevScript({ groupId = 'input', rulePath = RULE_PATH, useSudo = true, comment = '' } = {}) {
  const sudo = useSudo ? 'sudo ' : '';
  const raw = sanitizeGroup(groupId);
  const group = raw === null ? 'input' : raw;
  const rule = ruleLine({ groupId: group });

  const install = `echo '${rule}' | ${sudo}tee ${rulePath} >/dev/null`;
  const reload = `${sudo}udevadm control --reload-rules && ${sudo}udevadm trigger --action=change --subsystem-match=hidraw`;
  const suffix = comment ? `   # ${comment}` : '';
  const verify = `getfacl /dev/hidraw6${suffix}`;
  const remove = `${sudo}rm ${rulePath} && ${sudo}udevadm control --reload-rules`;

  // No rule needed: hand the current nodes over to a group the user is in.
  const chgrp = group || 'input';
  const chmod =
    'for h in /sys/class/hidraw/hidraw*; do ' +
    `[ "$(cat "$h/device/../idVendor" 2>/dev/null)" = "${VENDOR}" ] && ` +
    `${sudo}chgrp ${chgrp} "/dev/${'${h##*/}'}" && ${sudo}chmod 0660 "/dev/${'${h##*/}'}"; ` +
    'done';

  const oneShot = [install, reload, verify].join('\n');

  return { rule, path: rulePath, group, install, reload, verify, remove, chmod, oneShot };
}
