# UniRig architecture configuration

`spritebook_sidecar/adapters/unirig_opt/config.json` is SpriteBook's architecture description. It
contains no Meta model config, weights or tokenizer data.

The independent MIT
[fairseq 350M architecture](https://github.com/facebookresearch/fairseq/blob/3d262bb25690e4eb2e7d3c1309b1e9c406ca4b99/fairseq/models/transformer_lm.py#L547)
declares 24 layers, width 1024 and 16 heads; its base architecture sets FFN width to four times
model width (4096). Its [MIT notice](fairseq-MIT.txt) is retained.

MIT
[UniRig configuration](https://github.com/VAST-AI-Research/UniRig/blob/6793c6640ff01c8fb389f3993434124bb43d2933/configs/model/unirig_ar_350m_1024_81920_float32.yaml)
sets projection width 1024, maximum positions 3076 and pre-layer normalization. The pinned UniRig
skeleton checkpoint independently confirms 24 decoder layers, 1024-wide query projections, 4096-wide
FFN, 267 custom tokens and 3078 positions (the implementation reserves two). Head count comes from
fairseq, not tensor shapes.

Other behavior comes from the pinned Apache-2.0
[Transformers 4.51.3 OPTConfig](https://github.com/huggingface/transformers/blob/5f4ecf2d9f867a1255131d2461d75793c0cf1db2/src/transformers/models/opt/configuration_opt.py).
UniRig still applies its vocabulary, float32, attention and normalization overrides. The external
Transformers wheel carries its Apache license.

The historical `facebook/opt-350m` config is excluded from the new catalog version: its pinned
agreement restricts commercial/production use. Existing version files and receipts are preserved;
the adapter always uses this owned architecture file. An effective-config comparison found all 25
active fields unchanged. Differences are source metadata, unused `activation_dropout` and a
text-pipeline `prefix` that the pinned OPT model does not read. The legacy config was inspected
privately; it is neither copied into this file nor shipped in the application.
