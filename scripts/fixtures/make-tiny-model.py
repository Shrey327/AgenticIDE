import json
from pathlib import Path
import sys
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast

root = Path(sys.argv[1])
root.mkdir(exist_ok=True)
vocabulary = {'[UNK]': 0, '[PAD]': 1, '[EOS]': 2, 'local': 3, 'training': 4, 'is': 5, 'private': 6, 'and': 7, 'observable': 8}
tokenizer = Tokenizer(models.WordLevel(vocabulary, unk_token='[UNK]'))
tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
fast = PreTrainedTokenizerFast(tokenizer_object=tokenizer, unk_token='[UNK]', pad_token='[PAD]', eos_token='[EOS]')
fast.save_pretrained(root)
GPT2LMHeadModel(GPT2Config(vocab_size=len(vocabulary), n_positions=256, n_embd=16, n_layer=1, n_head=2, eos_token_id=2, pad_token_id=1)).save_pretrained(root)
(root / 'data.jsonl').write_text('\n'.join(json.dumps({'text': 'local training is private and observable'}) for _ in range(8)))
