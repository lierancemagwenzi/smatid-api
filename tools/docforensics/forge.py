#!/usr/bin/env python3
"""
Makes scanned document pages, clean and forged, for training and testing the image forgery model.

Each page is a made-up bank statement, payslip or bill, rendered at 150 dpi and "scanned": a paper tone,
a little blur and noise, saved as a JPEG. A forged page then has one or two changes made to the picture,
the way people doctor scans, and a mask marking exactly which pixels changed:

  retype     a figure painted over with the paper colour and typed again (another font or size, or not)
  copymove   a patch of the same page copied over a figure
  splice     a patch from another scan (other compression, other scale) pasted over a figure
  smudge     a figure blurred or smeared out
  shift      digits cut out and pasted back a pixel or two away

The forged page is saved as a JPEG again, so, as in real life, the untouched parts have been compressed
twice and the changed parts once (or differently).

    python forge.py --out data --count 1200          training data: images/, masks/, index.jsonl
    python forge.py --samples ../../storage/doccheck-samples/scans   a few pages to make scanned sample PDFs

Everyone and everything on the pages is made up.
"""
import argparse
import io
import json
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1240, 1754  # A4 at 150 dpi
FONT_DIR = "/System/Library/Fonts/Supplemental"
FONTS = {
    "arial": "Arial.ttf", "arial_bold": "Arial Bold.ttf", "arial_narrow": "Arial Narrow.ttf",
    "courier": "Courier New.ttf", "georgia": "Georgia.ttf", "times": "Times New Roman.ttf", "verdana": "Verdana.ttf",
    "tahoma": "Tahoma.ttf",
}
BODY_FONTS = ["arial", "verdana", "tahoma", "georgia", "times", "arial_narrow"]
NAMES = ["TENDAI MOYO", "TARIRO NCUBE", "FARAI CHIKOWO", "RUTENDO SIBANDA", "KUDA MAPFUMO", "NYASHA DUBE"]
DESCRIPTIONS = ["POS PURCHASE OK MART", "SALARY ACME LTD", "ZESA PREPAID", "ECOCASH TRANSFER", "ATM WITHDRAWAL",
                "BANK CHARGES", "TRANSFER FROM T NCUBE", "WATER ACCOUNT", "AIRTIME PURCHASE", "SCHOOL FEES"]


def font(name, size):
    path = os.path.join(FONT_DIR, FONTS[name])
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def money(v):
    return f"{v:,.2f}"


def render(rng):
    """A clean page: returns the image (L) and the boxes of its figures [(x0, y0, x1, y1, text, fontname, size)]."""
    tone = rng.randint(236, 252)
    img = Image.new("L", (W, H), tone)
    d = ImageDraw.Draw(img)
    body = rng.choice(BODY_FONTS)
    size = rng.randint(18, 23)
    ink = rng.randint(10, 50)
    figures = []

    def text(x, y, s, f=body, sz=size, right=False):
        fo = font(f, sz)
        if right:
            x = x - d.textlength(s, font=fo)
        d.text((x, y), s, font=fo, fill=ink)
        return tuple(int(round(v)) for v in d.textbbox((x, y), s, font=fo))

    kind = rng.choice(["statement", "payslip", "bill"])
    text(80, 70, {"statement": "HARBOUR BANK", "payslip": "ACME LOGISTICS (PVT) LTD", "bill": "CITY OF HARARE"}[kind], "arial_bold", 40)
    text(80, 125, {"statement": "Account statement", "payslip": "Payslip", "bill": "Water and refuse account"}[kind], body, 26)
    name = rng.choice(NAMES)
    text(80, 190, "Name:"), text(300, 190, name)
    text(80, 225, "Account number:"), text(300, 225, f"{rng.randint(1000, 9999)} {rng.randint(1000, 9999)} {rng.randint(1000, 9999)}")
    text(700, 190, "Period:"), text(840, 190, "01/09/2026 - 30/09/2026")

    y = 330
    cols = [700, 880, 1110] if kind == "statement" else [1110]
    balance = rng.uniform(200, 3000)
    for i in range(rng.randint(14, 26)):
        text(80, y, f"{rng.randint(1, 28):02d}/09/2026")
        text(260, y, rng.choice(DESCRIPTIONS))
        amount = round(rng.uniform(4, 900), 2)
        balance += amount if rng.random() < 0.3 else -amount
        values = [money(amount), "", money(balance)] if kind == "statement" else [money(amount)]
        for x, v in zip(cols, values):
            if v:
                box = text(x, y, v, right=True)
                figures.append((*box, v, body, size))
        y += size + rng.randint(14, 22)
    y += 30
    box = text(cols[-1], y, money(balance), "arial_bold" if body.startswith("arial") else body, size + 2, right=True)
    text(80, y, "Closing balance" if kind == "statement" else "Total", "arial_bold", size + 2)
    figures.append((*box, money(balance), body, size + 2))
    text(80, H - 120, "This document was generated electronically.", body, 16)
    return img, figures


def scan(img, rng, quality=None):
    """Blur, noise and a JPEG save, as a scanner or phone leaves it. Returns the decoded result and its quality."""
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.0)))
    a = np.asarray(img, dtype=np.float32)
    a = a + np.random.default_rng(rng.randint(0, 2**31)).normal(0, rng.uniform(1.5, 4.5), a.shape)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    q = quality or rng.randint(70, 94)
    return jpeg(img, q), q


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=q)
    buf.seek(0)
    return Image.open(buf).convert("L")


def paper_colour(a, box):
    x0, y0, x1, y1 = box
    ring = np.concatenate([a[max(0, y0 - 6):y0 - 2, x0:x1].ravel(), a[y1 + 2:y1 + 6, x0:x1].ravel()])
    return int(np.median(ring)) if ring.size else 245


def forge(img, figures, rng, kind=None):
    """Changes one figure in the picture. Returns (image, mask, kind)."""
    a = np.asarray(img).copy()
    mask = np.zeros_like(a, dtype=np.uint8)
    x0, y0, x1, y1, value, body, size = rng.choice(figures)
    pad = 4
    box = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
    bx0, by0, bx1, by1 = box
    kind = kind or rng.choice(["retype", "retype", "copymove", "splice", "smudge", "shift"])

    if kind == "retype":
        a[by0:by1, bx0:bx1] = paper_colour(a, box) + np.random.default_rng(rng.randint(0, 2**31)).normal(0, 1.0, (by1 - by0, bx1 - bx0)).astype(np.int16).clip(-3, 3)
        patch = Image.fromarray(a)
        d = ImageDraw.Draw(patch)
        new = money(float(value.replace(",", "")) + rng.choice([100, 250, 1000, 9, 50]))
        f = rng.choice([body, body, rng.choice(BODY_FONTS)])
        fo = font(f, size + rng.choice([0, 0, 1, -1]))
        tx = x1 - d.textlength(new, font=fo)
        d.text((tx, y0 + rng.choice([0, 0, 1, -1, 2])), new, font=fo, fill=rng.randint(10, 60))
        if rng.random() < 0.5:
            patch = patch.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 0.7)))
        a = np.asarray(patch).copy()
        nb = d.textbbox((tx, y0), new, font=fo)
        mx0, my0, mx1, my1 = min(bx0, int(nb[0]) - 2), by0, max(bx1, int(nb[2]) + 2), by1
        mask[max(0, my0):my1, max(0, mx0):mx1] = 255
    elif kind == "copymove":
        other = rng.choice(figures)
        ox0, oy0 = max(0, other[0] - pad), max(0, other[1] - pad)
        h, w = by1 - by0, bx1 - bx0
        src = a[oy0:oy0 + h, ox0:ox0 + w]
        if src.shape == (h, w):
            a[by0:by1, bx0:bx1] = src
        mask[by0:by1, bx0:bx1] = 255
    elif kind == "splice":
        donor, _ = render(rng)
        donor, _ = scan(donor, rng, rng.randint(55, 98))
        if rng.random() < 0.5:
            donor = donor.resize((int(W * rng.uniform(0.9, 1.1)), int(H * rng.uniform(0.9, 1.1))))
        d = np.asarray(donor)
        h, w = by1 - by0, bx1 - bx0
        sy, sx = rng.randint(330, min(d.shape[0] - h - 1, 1200)), rng.randint(600, d.shape[1] - w - 1)
        a[by0:by1, bx0:bx1] = d[sy:sy + h, sx:sx + w]
        mask[by0:by1, bx0:bx1] = 255
    elif kind == "smudge":
        region = Image.fromarray(a[by0:by1, bx0:bx1]).filter(ImageFilter.GaussianBlur(rng.uniform(1.5, 3.5)))
        a[by0:by1, bx0:bx1] = np.asarray(region)
        mask[by0:by1, bx0:bx1] = 255
    else:  # shift
        dx, dy = rng.choice([-2, -1, 1, 2]), rng.choice([-1, 0, 1])
        part = a[by0:by1, bx0:bx1].copy()
        a[by0:by1, bx0:bx1] = paper_colour(a, box)
        a[by0 + dy:by1 + dy, bx0 + dx:bx1 + dx] = part
        mask[min(by0, by0 + dy):max(by1, by1 + dy), min(bx0, bx0 + dx):max(bx1, bx1 + dx)] = 255
    return Image.fromarray(a), mask, kind


def make(seed, forged, kind=None):
    rng = random.Random(seed)
    clean, figures = render(rng)
    img, q1 = scan(clean, rng)
    mask = np.zeros((H, W), dtype=np.uint8)
    kinds = []
    if forged:
        for _ in range(1 if kind or rng.random() < 0.75 else 2):
            img, m, done = forge(img, figures, rng, kind)
            mask = np.maximum(mask, m)
            kinds.append(done)
    q2 = rng.randint(70, 95)
    # Saved again after editing (or, for a clean page, just saved: some clean scans are saved twice too).
    img = jpeg(img, q2) if forged or rng.random() < 0.5 else img
    return img, Image.fromarray(mask), {"forged": forged, "kinds": kinds, "q1": q1, "q2": q2}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data")
    ap.add_argument("--count", type=int, default=1200)
    ap.add_argument("--start", type=int, default=0, help="first seed (use a different range for a test set)")
    ap.add_argument("--samples", help="write a clean and a forged page here, for the scanned sample PDFs")
    args = ap.parse_args()

    if args.samples:
        os.makedirs(args.samples, exist_ok=True)
        for name, seed, forged in [("scan-clean", 7, False), ("scan-forged", 11, True)]:
            img, mask, meta = make(seed, forged, "retype" if forged else None)
            img.save(os.path.join(args.samples, f"{name}.jpg"), "JPEG", quality=90)
            mask.save(os.path.join(args.samples, f"{name}-mask.png"))
            with open(os.path.join(args.samples, f"{name}.json"), "w") as f:
                json.dump(meta, f)
        print(f"Wrote 2 scanned pages to {args.samples}")
        return

    os.makedirs(os.path.join(args.out, "images"), exist_ok=True)
    os.makedirs(os.path.join(args.out, "masks"), exist_ok=True)
    with open(os.path.join(args.out, "index.jsonl"), "w") as index:
        for i in range(args.start, args.start + args.count):
            img, mask, meta = make(i, forged=(i % 10) >= 3)  # 70% forged
            name = f"p{i:05d}"
            img.save(os.path.join(args.out, "images", f"{name}.png"))  # lossless: the JPEG history is already in it
            mask.save(os.path.join(args.out, "masks", f"{name}.png"))
            index.write(json.dumps({"name": name, **meta}) + "\n")
            if (i - args.start) % 100 == 99:
                print(f"  {i - args.start + 1} pages")
    print(f"Wrote {args.count} pages to {args.out}")


if __name__ == "__main__":
    main()
