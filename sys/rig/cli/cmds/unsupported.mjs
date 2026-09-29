// Recognized capabilities which this workspace shell cannot provide.
// Handlers deliberately accept no I/O, runtime, process or grant dependencies.
const reasons = Object.freeze({
  curl: 'a governed egress policy for curl',
  wget: 'a governed egress policy for wget',
  ssh: 'a governed egress policy and remote process transport for ssh',
  chown: 'POSIX file ownership and user IDs',
  chgrp: 'POSIX group ownership and group IDs',
  mount: 'host filesystem mounts',
  findmnt: 'a host mount table',
  df: 'filesystem capacity and free-space metrics',
  mknod: 'device node creation',
  mkfifo: 'named pipes (FIFOs)',
  kill: 'host process signals',
  nice: 'process scheduling priority',
  nohup: 'detached processes and host signal handling',
  su: 'host user identity switching',
  runas: 'host user identity switching',
  stdbuf: 'native process stdio buffering',
  shred: 'guaranteed physical storage erasure',
  dd: 'raw device and block I/O',
  getent: 'host account and name-service databases',
  hostname: 'host network identity',
  logname: 'host login sessions',
  dircolors: 'a terminal color database',
  pathchk: 'host filesystem filename and path limits',
  getfacl: 'POSIX access control lists (ACLs)',
  setfacl: 'POSIX access control lists (ACLs)',
  chacl: 'POSIX access control lists (ACLs)',
  attr: 'filesystem extended attributes',
  getfattr: 'filesystem extended attributes',
  setfattr: 'filesystem extended attributes',
  xfs_io: 'XFS-specific filesystem I/O',
  chcon: 'SELinux security contexts',
  runcon: 'SELinux process security contexts',
  chroot: 'process filesystem root isolation',
  groups: 'a host group membership database',
  hostid: 'a host identity identifier',
  install: 'installation ownership and permission modes',
  pinky: 'a host user login database',
  who: 'host login sessions',
  users: 'host login sessions',
  uptime: 'host uptime and load metrics',
  stty: 'terminal device control',
  sync: 'storage flush and durability guarantees',
  tty: 'terminal device identity',
});

export const unsupportedCommandNames = Object.freeze(Object.keys(reasons).sort());
export const unsupportedReason = name => Object.hasOwn(reasons, name) ? reasons[name] : null;

export function createUnsupportedCommands() {
  return Object.fromEntries(unsupportedCommandNames.map(name => [name,
    () => ({ text: `${name}: unavailable; requires ${reasons[name]}`, code: 1 }),
  ]));
}
