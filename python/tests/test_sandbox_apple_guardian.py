import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HELPER = Path(__file__).resolve().parents[1] / 'aiide_runtime' / 'sandbox_apple.py'
spec = importlib.util.spec_from_file_location('sandbox_apple_guardian', HELPER)
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)

FAKE_CLI = r'''#!/usr/bin/env python3
import json,os,signal,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_DIRECTORY'])
arguments=sys.argv[1:]
if arguments[0]=='run':
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 (root/'run.pid').write_text(str(os.getpid()))
 (root/'started').write_text('started')
 time.sleep(float(os.getenv('FIXTURE_CREATE_DELAY','0')))
 config={'id':arguments[arguments.index('--name')+1],'labels':json.loads(os.environ['FIXTURE_LABELS'])}
 (root/'state').write_text(json.dumps([{'configuration':config}]))
 (root/'created').write_text('created')
 time.sleep(60)
elif arguments[0]=='inspect':
 if not (root/'state').exists():sys.exit(1)
 print((root/'state').read_text())
elif arguments[0]=='delete':
 (root/'deleted').write_text(json.dumps(arguments))
 (root/'state').unlink(missing_ok=True)
else:sys.exit(2)
'''

MOCK_IDE = r'''
import os,subprocess,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_DIRECTORY'])
read,write=os.pipe()
if os.getenv('FIXTURE_CLOSED')=='1':os.close(write)
bootstrap='import os,sys;descriptor=int(sys.argv[1]);os.dup2(descriptor,3);os.set_inheritable(3,True);os.execv(sys.executable,[sys.executable,"-I",*sys.argv[2:]])'
child=subprocess.Popen([sys.executable,'-c',bootstrap,str(read),*sys.argv[1:]],pass_fds=(read,),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.close(read)
(root/'guardian.pid').write_text(str(child.pid))
if os.getenv('FIXTURE_CLOSED')!='1':
 while not (root/'close').exists():time.sleep(.02)
 os.close(write)
sys.exit(child.wait())
'''


@unittest.skipIf(os.name == 'nt', 'POSIX descriptor supervision')
class AppleGuardianTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aiide-apple-guardian-')
        self.root = Path(self.temporary.name)
        self.name = 'aiide-vm-' + str(uuid.uuid4())
        self.owner = 'a' * 64
        self.command = str(uuid.uuid4())
        self.labels = {'aiide.workspace': self.owner, 'aiide.managed': 'sandbox-vm-v1', 'aiide.command': self.command}
        self.binary = self.root / 'container'
        self.binary.write_text(FAKE_CLI)
        self.binary.chmod(0o700)
        self.ide = None

    def tearDown(self):
        if self.ide and self.ide.poll() is None:
            self.ide.kill()
        if self.ide:
            self.ide.wait(timeout=3)
        # An interrupted test must not retain its deliberately TERM-resistant fixture.
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and self.alive('guardian.pid'):
            time.sleep(.05)
        for file in ('guardian.pid', 'run.pid'):
            if self.alive(file):
                try:
                    os.kill(int((self.root/file).read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.temporary.cleanup()

    def alive(self, file):
        if not (self.root/file).exists():
            return False
        try:
            os.kill(int((self.root/file).read_text()), 0)
            return True
        except ProcessLookupError:
            return False

    def wait_for(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.03)
        self.fail('Timed out waiting for guardian lifecycle')

    def start(self, *, delay=0, labels=None, closed=False):
        env = {**os.environ, 'AIIDE_APPLE_CONTAINER': str(self.binary),
               'FIXTURE_DIRECTORY': str(self.root), 'FIXTURE_CREATE_DELAY': str(delay),
               'FIXTURE_LABELS': json.dumps(labels or self.labels), 'FIXTURE_CLOSED': str(int(closed))}
        self.ide = subprocess.Popen([sys.executable, '-c', MOCK_IDE, str(HELPER), self.name, self.owner,
                                     self.command, 'run', '--name', self.name, 'image', 'ignored'],
                                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_ownership_requires_exact_name_workspace_command_and_managed_labels(self):
        value = [{'configuration': {'id': self.name, 'labels': self.labels}}]
        self.assertTrue(guardian.owned(value, self.name, self.owner, self.command))
        for field, replacement in [('aiide.workspace','other'), ('aiide.command',str(uuid.uuid4())), ('aiide.managed','other')]:
            changed = [{'configuration': {'id': self.name, 'labels': {**self.labels, field: replacement}}}]
            self.assertFalse(guardian.owned(changed, self.name, self.owner, self.command))
        for malformed in (None, {}, [], [None], value * 2, [{'configuration': {'id': 'other', 'labels': self.labels}}]):
            self.assertFalse(guardian.owned(malformed, self.name, self.owner, self.command))

    def test_already_dead_ide_never_launches_container_cli(self):
        self.start(closed=True)
        self.assertEqual(self.ide.wait(timeout=5), 143)
        self.assertFalse((self.root/'started').exists())

    def test_sigkill_of_ide_removes_owned_vm_and_resistant_cli(self):
        self.start()
        self.wait_for(lambda: (self.root/'created').exists())
        self.ide.kill()
        self.ide.wait(timeout=3)
        self.wait_for(lambda: (self.root/'deleted').exists())
        self.wait_for(lambda: not self.alive('run.pid'))
        self.assertFalse((self.root/'state').exists())
        self.assertEqual(json.loads((self.root/'deleted').read_text()), ['delete', '--force', self.name])

    def test_create_finishing_after_ide_death_is_still_cleaned(self):
        self.start(delay=.4)
        self.wait_for(lambda: (self.root/'started').exists())
        self.assertFalse((self.root/'created').exists())
        self.ide.kill()
        self.ide.wait(timeout=3)
        self.wait_for(lambda: (self.root/'deleted').exists())
        self.assertTrue((self.root/'created').exists())
        self.assertFalse((self.root/'state').exists())

    def test_later_command_is_never_deleted_by_an_old_guardian(self):
        self.start(labels={**self.labels, 'aiide.command': str(uuid.uuid4())})
        self.wait_for(lambda: (self.root/'created').exists())
        (self.root/'close').write_text('close liveness pipe')
        self.assertEqual(self.ide.wait(timeout=5), 143)
        self.assertTrue((self.root/'state').exists())
        self.assertFalse((self.root/'deleted').exists())


if __name__ == '__main__':
    unittest.main()
