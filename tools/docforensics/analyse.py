"""Per-kind results of a forgery model on the test pages, and where it marks clean pages."""
import json, os, sys
import numpy as np, onnxruntime as ort
from PIL import Image
model, data = sys.argv[1], sys.argv[2]
s = ort.InferenceSession(model)
rows = [json.loads(l) for l in open(os.path.join(data, "index.jsonl"))][:120]
by_kind, clean_hits = {}, []
for r in rows:
    img = np.asarray(Image.open(os.path.join(data, "images", r["name"] + ".png")), dtype=np.float32) / 255
    h, w = img.shape
    H, W = (h + 15) // 16 * 16, (w + 15) // 16 * 16
    x = np.full((H, W), 0.95, np.float32); x[:h, :w] = img
    p = s.run(None, {"page": x[None, None]})[0][0, 0, :h, :w]
    pooled = p[: h // 8 * 8, : w // 8 * 8].reshape(h // 8, 8, w // 8, 8).mean((1, 3))
    m = np.asarray(Image.open(os.path.join(data, "masks", r["name"] + ".png"))) > 127
    if r["forged"]:
        mp = m[: h // 8 * 8, : w // 8 * 8].reshape(h // 8, 8, w // 8, 8).mean((1, 3)) > 0.3
        inside = pooled[mp].max() if mp.any() else 0
        outside = pooled[~mp].max()
        for k in r["kinds"]:
            by_kind.setdefault(k, []).append((inside, outside))
    else:
        ys, xs = np.unravel_index(np.argmax(pooled), pooled.shape)
        clean_hits.append((round(float(pooled.max()), 3), int(ys * 8), int(xs * 8), round(float((pooled > 0.5).mean() * 100), 2)))
for k, v in by_kind.items():
    v = np.array(v)
    print(f"{k:9s} n={len(v):3d}  inside max mean {v[:,0].mean():.3f}  >0.5: {(v[:,0]>0.5).mean():.2f}   outside max mean {v[:,1].mean():.3f}")
print("clean pages: (max, y, x, % cells > 0.5)")
for c in sorted(clean_hits, reverse=True)[:12]: print("  ", c)
