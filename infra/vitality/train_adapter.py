# infra/vitality/train_adapter.py
#
# Fabrique d'adaptateurs QLoRA pour la Réserve Vivante de SkyAInet.
# Deux verbes : « train » entraîne un adaptateur LoRA sur Qwen3-8B à partir d'un
# JSONL produit par la Data Factory ; « merge » le fusionne en checkpoint plein
# (ingrédient pour merge_base_dare_ties.yaml).
#
# SIDECAR : ce script tourne sur GPU (loué au début, matériel propre ensuite).
#   QLoRA sur un 8B demande ~12-16 Go de VRAM. Il NE tourne PAS utilement sur CPU.
#
# DONNÉES : JSONL, une ligne =
#   {"messages": [{"role": "user", "content": ...},
#                 {"role": "assistant", "content": ...}]}
#   C'est le format qu'émet le robinet Data Factory (cockpit → trame vérifiée,
#   code → tests passés, etc.).
#
# DÉPENDANCES (à ÉPINGLER — l'écosystème bouge vite) :
#   pip install "transformers>=4.51" peft trl datasets bitsandbytes accelerate
#
# ENTRAÎNER :
#   python train_adapter.py train --base Qwen/Qwen3-8B \
#       --data data/skyai-trading.jsonl --out ./skyai-trading-adapter
#
# FUSIONNER (adaptateur → checkpoint plein bf16, ingrédient DARE-TIES) :
#   python train_adapter.py merge --base Qwen/Qwen3-8B \
#       --adapter ./skyai-trading-adapter --out ./skyai-deepseek-distill-merged
#
# AVAL (hors de ce script) — rendre le checkpoint utilisable en local :
#   python convert_hf_to_gguf.py ./skyai-deepseek-distill-merged \
#       --outfile spec-f16.gguf --outtype f16
#   llama-quantize spec-f16.gguf spec-Q4_K_M.gguf Q4_K_M
#   → charger dans node-llama-cpp. (Ou fusionner d'abord plusieurs specs via mergekit.)

import argparse

# Modules cibles LoRA pour l'architecture Qwen (attention + MLP).
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj",
                  "gate_proj", "up_proj", "down_proj"]


def build_dataset(data_path, tokenizer):
    """Charge le JSONL et applique le gabarit de chat Qwen3 → colonne 'text'."""
    from datasets import load_dataset
    ds = load_dataset("json", data_files=data_path, split="train")

    def to_text(row):
        # Si tu distilles des traces de raisonnement (R1), garde le format
        # thinking cohérent avec le gabarit Qwen3.
        return {"text": tokenizer.apply_chat_template(
            row["messages"], tokenize=False, add_generation_prompt=False)}

    return ds.map(to_text, remove_columns=ds.column_names)


def train(args):
    import torch
    from transformers import (AutoTokenizer, AutoModelForCausalLM,
                              BitsAndBytesConfig)
    from peft import LoraConfig, prepare_model_for_kbit_training
    from trl import SFTTrainer, SFTConfig

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Quantisation 4-bit NF4 — le cœur de QLoRA (base gelée en 4-bit,
    # seuls les adaptateurs sont entraînés).
    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base, quantization_config=bnb, device_map="auto",
        torch_dtype=torch.bfloat16)
    model = prepare_model_for_kbit_training(model)

    lora = LoraConfig(
        r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05,
        bias="none", task_type="CAUSAL_LM", target_modules=TARGET_MODULES)

    dataset = build_dataset(args.data, tokenizer)

    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        bf16=True,
        logging_steps=10,
        save_strategy="epoch",
        dataset_text_field="text",
        max_seq_length=args.max_len,
        packing=False,
    )
    trainer = SFTTrainer(
        model=model, args=cfg, train_dataset=dataset,
        peft_config=lora, processing_class=tokenizer)
    trainer.train()
    trainer.save_model(args.out)          # sauvegarde l'adaptateur LoRA seul
    print("Adaptateur ecrit dans", args.out)


def merge(args):
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel

    # Base en pleine précision (PAS quantisée) pour une fusion propre.
    base = AutoModelForCausalLM.from_pretrained(
        args.base, torch_dtype=torch.bfloat16, device_map="cpu")
    merged = PeftModel.from_pretrained(base, args.adapter).merge_and_unload()
    merged.save_pretrained(args.out, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.base).save_pretrained(args.out)
    print("Checkpoint plein fusionne ecrit dans", args.out)


def main():
    p = argparse.ArgumentParser(
        description="Fabrique d'adaptateurs QLoRA SkyAInet")
    sub = p.add_subparsers(dest="mode", required=True)

    t = sub.add_parser("train", help="Entrainer un adaptateur LoRA")
    t.add_argument("--base", default="Qwen/Qwen3-8B")
    t.add_argument("--data", required=True, help="JSONL {messages:[...]}")
    t.add_argument("--out", required=True)
    t.add_argument("--rank", type=int, default=16)
    t.add_argument("--epochs", type=float, default=1.0)
    t.add_argument("--batch", type=int, default=1)
    t.add_argument("--grad-accum", type=int, default=16)
    t.add_argument("--lr", type=float, default=2e-4)
    t.add_argument("--max-len", type=int, default=4096)
    t.set_defaults(func=train)

    m = sub.add_parser("merge", help="Fusionner l'adaptateur en checkpoint plein")
    m.add_argument("--base", default="Qwen/Qwen3-8B")
    m.add_argument("--adapter", required=True)
    m.add_argument("--out", required=True)
    m.set_defaults(func=merge)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
