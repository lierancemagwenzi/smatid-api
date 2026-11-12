#!/usr/bin/env python3
"""
Trains the image forgery model: a small fully-convolutional network (a U-Net, ~0.4M parameters) that marks
the pixels of a scanned page that were changed. Its first layer is a fixed set of high-pass filters (the
"SRM" filters used in image forensics), so it looks at the noise and compression traces editing leaves,
not at what the text says.

    python forge.py --out ../../storage/docforensics/train --count 1000
    python forge.py --out ../../storage/docforensics/test --count 200 --start 100000
    python train.py --data ../../storage/docforensics --out ../../config/doc-models

Writes forensics.onnx and forensics.json (version, the page threshold, and its scores on the test pages).
The model takes a grey page, 0-1, at about 150 dpi ([1, 1, H, W], H and W multiples of 16) and gives the
probability that each pixel was changed.
"""
import argparse
import json
import os
import random
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

TILE = 256


# ----- The network -----

def srm_kernels():
    """Three classic high-pass filters, fixed: they take the picture away and leave its noise."""
    k1 = np.array([[0, 0, 0, 0, 0], [0, -1, 2, -1, 0], [0, 2, -4, 2, 0], [0, -1, 2, -1, 0], [0, 0, 0, 0, 0]], dtype=np.float32) / 4
    k2 = np.array([[-1, 2, -2, 2, -1], [2, -6, 8, -6, 2], [-2, 8, -12, 8, -2], [2, -6, 8, -6, 2], [-1, 2, -2, 2, -1]], dtype=np.float32) / 12
    k3 = np.array([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 1, -2, 1, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], dtype=np.float32) / 2
    return torch.tensor(np.stack([k1, k2, k3])[:, None])


def block(i, o):
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                         nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True))


class ForgeryNet(nn.Module):
    def __init__(self, w=16):
        super().__init__()
        self.register_buffer("srm", srm_kernels())
        self.e1 = block(4, w)
        self.e2 = block(w, w * 2)
        self.e3 = block(w * 2, w * 4)
        self.e4 = block(w * 4, w * 6)
        self.d3 = block(w * 6 + w * 4, w * 4)
        self.d2 = block(w * 4 + w * 2, w * 2)
        self.d1 = block(w * 2 + w, w)
        self.head = nn.Conv2d(w, 1, 1)

    def forward(self, x):
        noise = torch.clamp(F.conv2d(x * 255.0, self.srm, padding=2), -3, 3) / 3
        x = torch.cat([x * 2 - 1, noise], 1)
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        e4 = self.e4(F.max_pool2d(e3, 2))
        up = lambda t, ref: F.interpolate(t, size=ref.shape[-2:], mode="bilinear", align_corners=False)
        d3 = self.d3(torch.cat([up(e4, e3), e3], 1))
        d2 = self.d2(torch.cat([up(d3, e2), e2], 1))
        d1 = self.d1(torch.cat([up(d2, e1), e1], 1))
        return self.head(d1)


class Exported(nn.Module):
    """What's exported: probabilities, not logits."""

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        return torch.sigmoid(self.net(x))


# ----- The data -----

def load_split(root):
    index = [json.loads(l) for l in open(os.path.join(root, "index.jsonl"))]
    return [(os.path.join(root, "images", f"{r['name']}.png"), os.path.join(root, "masks", f"{r['name']}.png"), r) for r in index]


class Tiles(torch.utils.data.Dataset):
    """Random 256-pixel tiles; most tiles from a forged page include part of what was changed."""

    def __init__(self, pages, per_page=8, seed=0):
        self.pages = pages
        self.per_page = per_page
        self.seed = seed

    def __len__(self):
        return len(self.pages) * self.per_page

    def __getitem__(self, i):
        rng = random.Random(self.seed * 1_000_003 + i)
        img_path, mask_path, meta = self.pages[i // self.per_page]
        img = np.asarray(Image.open(img_path), dtype=np.float32) / 255
        mask = np.asarray(Image.open(mask_path), dtype=np.float32) / 255
        h, w = img.shape
        if meta["forged"] and rng.random() < 0.7:
            ys, xs = np.nonzero(mask)
            k = rng.randrange(len(ys))
            cy, cx = ys[k] + rng.randint(-100, 100), xs[k] + rng.randint(-100, 100)
        else:
            # Anywhere on the page, headings included: version 1 only saw the body, and took every page's large
            # bold title for an edit.
            cy, cx = rng.randint(TILE // 2, h - TILE // 2), rng.randint(TILE // 2, w - TILE // 2)
        y0 = int(np.clip(cy - TILE // 2, 0, h - TILE))
        x0 = int(np.clip(cx - TILE // 2, 0, w - TILE))
        t = img[y0:y0 + TILE, x0:x0 + TILE]
        m = mask[y0:y0 + TILE, x0:x0 + TILE]
        if rng.random() < 0.5:  # brightness and contrast vary between scanners
            t = np.clip((t - 0.5) * rng.uniform(0.85, 1.15) + 0.5 + rng.uniform(-0.04, 0.04), 0, 1)
        return torch.from_numpy(t[None].copy()), torch.from_numpy(m[None].copy())


def dice_loss(logits, target):
    p = torch.sigmoid(logits)
    inter = (p * target).sum((1, 2, 3))
    return 1 - ((2 * inter + 1) / (p.sum((1, 2, 3)) + target.sum((1, 2, 3)) + 1)).mean()


# ----- Scoring whole pages -----

def pad16(a):
    h, w = a.shape
    H, W = (h + 15) // 16 * 16, (w + 15) // 16 * 16
    out = np.full((H, W), np.median(a), dtype=np.float32)
    out[:h, :w] = a
    return out


@torch.no_grad()
def page_map(net, device, path):
    img = np.asarray(Image.open(path), dtype=np.float32) / 255
    x = torch.from_numpy(pad16(img))[None, None].to(device)
    p = torch.sigmoid(net(x))[0, 0].cpu().numpy()
    return p[:img.shape[0], :img.shape[1]]


def page_score(p):
    """How strongly a page is flagged: the mean of its most-flagged 8x8 pooled area (one spot doesn't count)."""
    t = torch.from_numpy(p)[None, None]
    return float(F.avg_pool2d(t, 8).max())


def evaluate(net, device, pages, threshold=None):
    net.eval()
    scores, labels = [], []
    tp = fp = fn = 0
    for img_path, mask_path, meta in pages:
        p = page_map(net, device, img_path)
        m = np.asarray(Image.open(mask_path)) > 127
        pred = p >= 0.5
        tp += int((pred & m).sum())
        fp += int((pred & ~m).sum())
        fn += int((~pred & m).sum())
        scores.append(page_score(p))
        labels.append(1 if meta["forged"] else 0)
    scores, labels = np.array(scores), np.array(labels)
    if threshold is None:  # the page threshold with the best balanced accuracy
        best = (0, 0.5)
        for t in np.unique(scores):
            tpr = ((scores >= t) & (labels == 1)).sum() / max(1, (labels == 1).sum())
            tnr = ((scores < t) & (labels == 0)).sum() / max(1, (labels == 0).sum())
            best = max(best, ((tpr + tnr) / 2, float(t)))
        threshold = best[1]
    caught = int(((scores >= threshold) & (labels == 1)).sum())
    alarms = int(((scores >= threshold) & (labels == 0)).sum())
    order = np.argsort(-scores)
    # AUC: the chance a forged page scores above a clean one.
    pos, neg = scores[labels == 1], scores[labels == 0]
    auc = float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()) if len(pos) and len(neg) else None
    return {
        "pages": len(pages), "forged": int(labels.sum()), "clean": int((labels == 0).sum()),
        "page_threshold": round(threshold, 4), "forged_caught": caught, "clean_flagged": alarms,
        "page_recall": round(caught / max(1, labels.sum()), 3), "page_false_alarm_rate": round(alarms / max(1, (labels == 0).sum()), 3),
        "page_auc": round(auc, 3) if auc is not None else None,
        "pixel_precision": round(tp / max(1, tp + fp), 3), "pixel_recall": round(tp / max(1, tp + fn), 3),
        "pixel_f1": round(2 * tp / max(1, 2 * tp + fp + fn), 3),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="../../storage/docforensics")
    ap.add_argument("--out", default="../../config/doc-models")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--version", type=int, default=1)
    args = ap.parse_args()

    torch.manual_seed(0)
    random.seed(0)
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    train_pages = load_split(os.path.join(args.data, "train"))
    test_pages = load_split(os.path.join(args.data, "test"))
    val_pages, train_pages = train_pages[:100], train_pages[100:]
    print(f"{len(train_pages)} training pages, {len(val_pages)} to pick the threshold, {len(test_pages)} to test on; {device}")

    net = ForgeryNet().to(device)
    print(f"{sum(p.numel() for p in net.parameters()):,} parameters")
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    loader_args = dict(batch_size=args.batch, num_workers=4, persistent_workers=True)
    steps = args.epochs * (len(train_pages) * 8 // args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=steps)
    pos_weight = torch.tensor([4.0], device=device)
    start = time.time()
    for epoch in range(args.epochs):
        net.train()
        loader = torch.utils.data.DataLoader(Tiles(train_pages, seed=epoch), shuffle=True, **loader_args)
        total = n = 0
        for x, m in loader:
            x, m = x.to(device), m.to(device)
            logits = net(x)
            loss = F.binary_cross_entropy_with_logits(logits, m, pos_weight=pos_weight) + dice_loss(logits, m)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += float(loss) * len(x)
            n += len(x)
        print(f"epoch {epoch + 1}/{args.epochs}: loss {total / n:.4f} ({time.time() - start:.0f}s)")

    val = evaluate(net, device, val_pages)
    test = evaluate(net, device, test_pages, threshold=val["page_threshold"])
    print("validation:", json.dumps(val))
    print("test:", json.dumps(test))

    os.makedirs(args.out, exist_ok=True)
    net.eval().cpu()
    onnx_path = os.path.join(args.out, "forensics.onnx")
    torch.onnx.export(Exported(net), torch.zeros(1, 1, 256, 256), onnx_path, input_names=["page"], output_names=["tampered"],
                      dynamic_axes={"page": {2: "height", 3: "width"}, "tampered": {2: "height", 3: "width"}}, opset_version=17)
    meta = {
        "version": args.version, "kind": "forgery-unet", "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "input": {"name": "page", "channels": 1, "range": [0, 1], "multiple_of": 16, "dpi": 150, "page_width_px": 1240},
        "output": {"name": "tampered", "meaning": "probability each pixel was changed"},
        "page_threshold": val["page_threshold"], "pixel_threshold": 0.5, "pool": 8,
        "trained_on": {"pages": len(train_pages), "source": "generated (tools/docforensics/forge.py)"},
        "validation": val, "test": test,
    }
    with open(os.path.join(args.out, "forensics.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Saved {onnx_path} ({os.path.getsize(onnx_path) / 1e6:.1f} MB) and forensics.json")


if __name__ == "__main__":
    main()
