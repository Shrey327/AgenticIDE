import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
export function sshFixture(root) {
  const command = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  const name = 'aiide-ui-ssh-' + process.pid, build = path.join(root, 'ssh-build'), remote = path.join(root, 'remote');
  fs.mkdirSync(build); fs.mkdirSync(remote, { mode: 0o777 }); fs.chmodSync(remote, 0o777);
  command('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', path.join(root, 'identity')]);
  fs.copyFileSync(path.join(root, 'identity.pub'), path.join(build, 'authorized_keys'));
  fs.copyFileSync('scripts/fixtures/ssh.Dockerfile', path.join(build, 'Dockerfile'));
  command('docker', ['build', '-t', name, build]);
  command('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::22', '--mount', `type=bind,src=${remote},dst=/project`, name]);
  const port = Number(command('docker', ['port', name, '22/tcp']).trim().split(':').pop());
  fs.writeFileSync(path.join(root, 'known_hosts'), `[127.0.0.1]:${port} ${command('docker', ['exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).trim()}\n`);
  fs.copyFileSync('scripts/fixtures/remote-train.py', path.join(remote, 'remote-train.py'));
  return {
    profile: { id: 'fixture', host: '127.0.0.1', user: 'trainer', port, root: '/project', python: '/usr/local/bin/python', identityFile: path.join(root, 'identity'), knownHostsFile: path.join(root, 'known_hosts') },
    close: () => { try { command('docker', ['rm', '-f', name]); } catch {} try { command('docker', ['image', 'rm', name]); } catch {} },
  };
}
