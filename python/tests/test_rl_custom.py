import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from aiide_rl import custom, advanced


class CustomSourceTests(unittest.TestCase):
    def test_reviewed_source_read_does_not_execute_and_changed_source_fails(self):
        previous=Path.cwd()
        with tempfile.TemporaryDirectory() as root:
            os.chdir(root)
            try:
                source=b"from pathlib import Path\nPath('executed').write_text('bad')\n"
                Path('env.py').write_bytes(source)
                definition={'id':'test','title':'Test','entrypoint':'env.py','factory':'make_env','files':[{'file':'env.py','sha256':hashlib.sha256(source).hexdigest()}],'parameters':{},'revision':'a'*64}
                self.assertEqual(custom.sources(definition)['env.py'],source)
                self.assertFalse(Path('executed').exists())
                c=advanced.config({'environment':'custom:test','customEnvironment':definition})
                self.assertEqual(c['customEnvironment']['id'],'test')
                Path('env.py').write_text('# modified')
                with self.assertRaisesRegex(ValueError,'changed'): custom.sources(definition)
            finally: os.chdir(previous)

    def test_custom_configuration_rejects_missing_mismatched_and_builtin_factory_injection(self):
        for config in ({'environment':'custom:test'}, {'environment':'CartPole-v1','customEnvironment':{}}, {'environment':'custom:../evil','customEnvironment':{}}, {'customEnvironment':'exec(code)'}):
            with self.assertRaises(ValueError): advanced.config(config)

    def test_source_paths_hashes_duplicates_and_json_are_bounded(self):
        definition={'id':'test','title':'Test','entrypoint':'env.py','factory':'make_env','files':[{'file':'env.py','sha256':'a'*64}],'parameters':{},'revision':'a'*64}
        for entry in ('../evil.py','/evil.py','a/../evil.py','a\\evil.py'):
            with self.assertRaises(ValueError): custom.definition({**definition,'entrypoint':entry,'files':[{'file':entry,'sha256':'a'*64}]})
        with self.assertRaises(ValueError): custom.definition({**definition,'files':definition['files']*2})
        with self.assertRaises(ValueError): custom.definition({**definition,'parameters':{'value':float('nan')}})
        with self.assertRaises(ValueError): custom.definition({**definition,'parameters':{'value':'x'*16000}})

    def test_rollout_enforces_review_after_the_final_policy_manifest_read(self):
        definition={'id':'test','title':'Test','entrypoint':'env.py','factory':'make_env','files':[{'file':'env.py','sha256':'a'*64}],'parameters':{},'revision':'a'*64}
        changed={'config':advanced.config({'environment':'custom:test','customEnvironment':definition})}
        with patch.object(advanced,'manifest',return_value=changed),patch.object(advanced,'make_environment') as make:
            with self.assertRaisesRegex(ValueError,'explicit'):advanced.rollout('policy.json',custom_environment=definition,allow_custom=False)
            with self.assertRaisesRegex(ValueError,'exact reviewed'):advanced.rollout('policy.json')
            make.assert_not_called()


@unittest.skipUnless(importlib.util.find_spec('gymnasium'),'optional Gymnasium runtime required')
class CustomEnvironmentTests(unittest.TestCase):
    def test_package_relative_imports_and_dataclasses_work_after_review(self):
        previous=Path.cwd()
        original=list(sys.path)
        sample=(Path(__file__).resolve().parents[2]/'templates/rl/custom_target.py').read_bytes()
        with tempfile.TemporaryDirectory() as root:
            os.chdir(root)
            try:
                Path('envs').mkdir()
                contents={'custom_target.py':sample,'envs/helper.py':b'VALUE=0.7\n','envs/factory.py':b'from dataclasses import dataclass\nfrom .helper import VALUE\nfrom custom_target import TargetEnvironment\n@dataclass\nclass Options:\n target:float=VALUE\ndef make_env(parameters):\n return TargetEnvironment(target=Options().target)\n'}
                for file,content in contents.items():Path(file).write_bytes(content)
                definition={'id':'package','title':'Package','entrypoint':'envs/factory.py','factory':'make_env','files':[{'file':file,'sha256':hashlib.sha256(content).hexdigest()}for file,content in contents.items()],'parameters':{},'revision':hashlib.sha256(contents['envs/factory.py']).hexdigest()}
                env=custom.make(definition,'ppo',10,42)
                try:self.assertAlmostEqual(float(env.reset(seed=42)[0][0]),0.7,places=5)
                finally:env.close()
            finally:
                os.chdir(previous);sys.path[:]=original
                for name in ('envs','envs.helper','custom_target'):sys.modules.pop(name,None)

    def test_supported_spaces_and_finite_transition_contract(self):
        previous=Path.cwd()
        source=(Path(__file__).resolve().parents[2]/'templates/rl/custom_target.py').read_bytes()
        with tempfile.TemporaryDirectory() as root:
            os.chdir(root)
            try:
                def definition(content):
                    Path('env.py').write_bytes(content)
                    return {'id':'test','title':'Test','entrypoint':'env.py','factory':'make_env','files':[{'file':'env.py','sha256':hashlib.sha256(content).hexdigest()}],'parameters':{},'revision':hashlib.sha256(content).hexdigest()}
                with self.assertRaisesRegex(ValueError,'continuous'):custom.make(definition(source),'sac',10,42)
                invalid=source.replace(b'self.observation_space = spaces.Box(-1,1,shape=(1,),dtype=np.float32)',b'self.observation_space = spaces.Box(0,1,shape=(1,),dtype=np.int64)')
                with self.assertRaisesRegex(ValueError,'flat floating-point'):custom.make(definition(invalid),'ppo',10,42)
                invalid=source.replace(b'float(1-error*error)',b"float('nan')")
                env=custom.make(definition(invalid),'ppo',10,42)
                try:
                    with self.assertRaisesRegex(ValueError,'finite reward'):env.step(1)
                finally:env.close()
            finally:os.chdir(previous)


if __name__=='__main__': unittest.main()
