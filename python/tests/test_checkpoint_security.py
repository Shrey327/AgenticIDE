import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from aiide_sdk.training import load_checkpoint


class CheckpointSecurityTests(unittest.TestCase):
    def test_vulnerable_or_prerelease_runtime_rejected_before_reading_files(self):
        for version in ('2.9.1','2.9.1+cpu','2.5.1','2.10.0rc1','2.10.0.dev0','invalid'):
            with patch.dict(sys.modules,{'torch':types.SimpleNamespace(__version__=version)}):
                with self.assertRaisesRegex(ValueError,'Torch >=2.10.0'):
                    load_checkpoint(None,None,'no-file-should-be-read')

    @unittest.skipUnless(os.environ.get('AIIDE_REAL_RL')=='1','set AIIDE_REAL_RL=1 with patched Torch for real checkpoint acceptance')
    def test_actual_patched_torch_checkpoint_roundtrip(self):
        import torch
        from aiide_sdk.training import save_checkpoint
        with tempfile.TemporaryDirectory() as root:
            model=torch.nn.Linear(1,1)
            optimizer=torch.optim.Adam(model.parameters(),lr=0.01)
            optimizer.zero_grad();loss=model(torch.tensor([[1.0]])).square().sum();loss.backward();optimizer.step()
            expected={key:value.clone() for key,value in model.state_dict().items()}
            save_checkpoint(model,optimizer,Path(root)/'checkpoint',3)
            with torch.no_grad():
                for value in model.parameters():value.zero_()
            self.assertEqual(load_checkpoint(model,optimizer,Path(root)/'checkpoint'),3)
            for key,value in model.state_dict().items():
                self.assertTrue(torch.equal(value,expected[key]))


if __name__=='__main__':unittest.main()
