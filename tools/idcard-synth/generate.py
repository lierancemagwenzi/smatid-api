#!/usr/bin/env python3
"""
Draws fake Zimbabwean national ID cards, photographed the way a phone would: tilted, off-centre, a bit
blurred, with glare and JPEG noise. Each picture comes with what's printed on it (the label), so the
cards can be read with OCR and used to train the ZW model before there are real labelled scans.

Every person is made up: names are drawn from common Zimbabwean names, ID numbers have a valid-format
check letter, and the "photo" is a drawn silhouette. The layouts are approximations of the metal and
plastic cards (the only two Zimbabwe issues); the plastic one follows real cards.

    python3 tools/idcard-synth/generate.py --count 300 --out storage/synthetic/ZW

Writes <out>/images/*.jpg and <out>/labels.jsonl. Then run make_samples.sh (or ocr.swift + samples.js).
"""
import argparse
import json
import math
import os
import random
from datetime import date, timedelta

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

# ----- Fake people -----

SURNAMES = [
    "MOYO", "NCUBE", "SIBANDA", "DUBE", "NDLOVU", "MPOFU", "SITHOLE", "SHUMBA", "CHIGUMBA", "MUTASA", "MAKONI",
    "CHIKOWORE", "MUSARURWA", "NYATHI", "MOYANA", "GUMBO", "MAPFUMO", "CHIMUKA", "MARUFU", "ZHOU", "MASHINGAIDZE",
    "CHINYAMA", "MUZENDA", "TSHUMA", "MHLANGA", "MUCHENA", "KAMBARAMI", "NHAMO", "MATANGA", "CHIRWA", "MANDAZA",
]
FIRST_NAMES = [
    "TARIRO", "TENDAI", "BLESSING", "RUVIMBO", "TAKUDZWA", "NYASHA", "FARAI", "TATENDA", "RUDO", "KUDZAI", "CHIPO",
    "TINASHE", "SIMBARASHE", "TAPIWA", "RUTENDO", "NOMVULA", "SIPHO", "THANDIWE", "MUNYARADZI", "TAFADZWA",
    "PRIVILEGE", "GIFT", "PRECIOUS", "MEMORY", "LOVEMORE", "TRUST", "GRACE", "PATIENCE", "JOHN", "MARY", "PETER",
]
PLACES = ["HARARE", "BULAWAYO", "MUTARE", "GWERU", "MASVINGO", "KWEKWE", "KADOMA", "CHINHOYI", "MARONDERA",
          "BINDURA", "CHITUNGWIZA", "HWANGE", "BEITBRIDGE", "VICTORIA FALLS", "ZVISHAVANE", "RUSAPE"]
VILLAGES = ["CHIKOMBA", "MAKONI", "ZAKA", "BUHERA", "GUTU", "NKAYI", "LUPANE", "MUREWA", "MUTOKO", "CHIPINGE",
            "BIKITA", "MBERENGWA", "TSHOLOTSHO", "UMZINGWANE", "SHURUGWI", "HURUNGWE", "SEKE", "MAZOWE"]

CHECK_LETTERS = "ZABCDEFGHJKLMNPQRSTVWXY"


def id_number(rng):
    district = f"{rng.randint(1, 86):02d}"
    serial = str(rng.randint(100000, 9999999))
    letter = CHECK_LETTERS[int(district + serial) % 23]
    origin = f"{rng.randint(1, 86):02d}"
    return f"{district}-{serial} {letter} {origin}"


def person(rng):
    born = date(1940, 1, 1) + timedelta(days=rng.randint(0, 365 * 66))
    issued = born + timedelta(days=365 * rng.randint(16, 50) + rng.randint(0, 364))
    issued = min(issued, date(2026, 10, 1))
    firsts = rng.sample(FIRST_NAMES, 2 if rng.random() < 0.45 else 1)
    return {
        "id_number": id_number(rng),
        "surname": rng.choice(SURNAMES),
        "first_names": " ".join(firsts),
        "date_of_birth": born.strftime("%d/%m/%Y"),
        "place_of_birth": rng.choice(PLACES),
        "village_of_origin": rng.choice(VILLAGES),
        "sex": rng.choice("MF"),
        "date_of_issue": issued.strftime("%d/%m/%Y"),
    }


# ----- Drawing -----

FONT_DIRS = ["/System/Library/Fonts/Supplemental", "/System/Library/Fonts", "/Library/Fonts", "/usr/share/fonts/truetype/dejavu"]


def font(names, size):
    for name in names:
        for d in FONT_DIRS:
            path = os.path.join(d, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


REGULAR = ["Arial.ttf", "Helvetica.ttc", "DejaVuSans.ttf"]
BOLD = ["Arial Bold.ttf", "Helvetica.ttc", "DejaVuSans-Bold.ttf"]
NARROW = ["Arial Narrow.ttf", "Arial.ttf", "DejaVuSans.ttf"]
MONO = ["Courier New Bold.ttf", "Courier New.ttf", "DejaVuSansMono.ttf"]

W, H = 856, 540  # 85.6 × 54 mm at 10 px/mm


def gradient(c1, c2, rng):
    a = np.linspace(0, 1, W)[None, :, None]
    b = np.linspace(0, 1, H)[:, None, None]
    t = (a * 0.6 + b * 0.4)
    img = (np.array(c1)[None, None, :] * (1 - t) + np.array(c2)[None, None, :] * t)
    img += np.random.default_rng(rng.randint(0, 10**9)).normal(0, 3, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def guilloche(draw, colour, rng):
    """Fine wavy security lines."""
    for k in range(18):
        pts = []
        phase = rng.random() * 6.28
        amp = 10 + k * 3
        for x in range(0, W + 8, 8):
            pts.append((x, H * 0.15 + k * 22 + amp * math.sin(x / 45 + phase)))
        draw.line(pts, fill=colour, width=1)


def silhouette(img, box, rng, colour=(90, 90, 95)):
    """A drawn head and shoulders, standing in for the holder's photo."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    bg = tuple(int(v) for v in np.clip(np.array([210, 215, 220]) + rng.randint(-20, 20), 0, 255))
    photo = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(photo)
    # Drawn on its own picture, so the shoulders are cut off at the frame.
    d.ellipse([w * 0.28, h * 0.12, w * 0.72, h * 0.56], fill=colour)
    d.ellipse([w * 0.05, h * 0.6, w * 0.95, h * 1.4], fill=colour)
    d.rectangle([0, 0, w - 1, h - 1], outline=(120, 120, 120), width=2)
    img.paste(photo, (x0, y0))


def text(d, xy, s, f, fill):
    d.text(xy, s, font=f, fill=fill)


def issued_between(p, start, end, rng):
    """Each card was issued in its own era: metal until the 1990s, plastic after."""
    born = date(int(p["date_of_birth"][6:]), int(p["date_of_birth"][3:5]), int(p["date_of_birth"][:2]))
    lo = max(start, born + timedelta(days=365 * 16))
    if lo >= end:
        return p
    return {**p, "date_of_issue": (lo + timedelta(days=rng.randint(0, (end - lo).days))).strftime("%d/%m/%Y")}


def small_caps(d, xy, s, size, fill):
    """Small capitals, as the plastic card's labels: "ID NUMBER" with the first letter of each word larger."""
    x, y = xy
    big, small = font(REGULAR, size), font(REGULAR, int(size * 0.78))
    for word in s.split(" "):
        d.text((x, y), word[0], font=big, fill=fill)
        x += d.textlength(word[0], font=big)
        rest = word[1:]
        if rest:
            d.text((x, y + size * 0.2), rest, font=small, fill=fill)
            x += d.textlength(rest, font=small)
        x += d.textlength(" ", font=big)


def card_plastic(p, rng):
    """Copied from real cards: a yellow band with the title, the photo on the left, small-capital labels with
    the values in bold italic on the same row, and the number followed by citizenship and sex ("CIT M")."""
    p = issued_between(p, date(1995, 1, 1), date(2026, 10, 1), rng)
    img = gradient((238, 238, 228), (226, 232, 222), rng)
    d = ImageDraw.Draw(img)
    guilloche(d, (215, 222, 210), rng)
    ink = (20, 20, 22)
    lab = (40, 40, 45)
    red = (190, 40, 40)
    # The yellow band and the title.
    d.rectangle([150, 22, 780, 98], fill=(240, 220, 60))
    small_caps(d, (300, 22), "REPUBLIC OF ZIMBABWE", 26, red)
    text(d, (262, 56), "NATIONAL REGISTRATION", font(REGULAR, 34), ink)
    silhouette(img, (24, 110, 230, 390), rng)
    # A faint copy of the photo on the right, and the fingerprint box.
    ghost = Image.new("RGB", (110, 140), (225, 225, 220))
    silhouette(ghost, (0, 0, 110, 140), rng, colour=(200, 195, 190))
    img.paste(ghost, (690, 150))
    text(d, (690, 330), "Fingerprint", font(REGULAR, 20), red)

    village = p["village_of_origin"] if rng.random() > 0.2 else ""
    rows = [("ID NUMBER", f"{p['id_number']} CIT {p['sex']}"), ("SURNAME", p["surname"]), ("FIRST NAME", p["first_names"]),
            ("DATE OF BIRTH", p["date_of_birth"]), ("VILLAGE OF ORIGIN", village), ("PLACE OF BIRTH", p["place_of_birth"]),
            ("DATE OF ISSUE", p["date_of_issue"])]
    value_font = font(["Arial Bold Italic.ttf", "Arial Bold.ttf", "DejaVuSans-BoldOblique.ttf"], 32)
    # The number is printed with a gap after the dash on some cards: "75- 191961".
    gap = " " if rng.random() < 0.5 else ""
    for i, (label, value) in enumerate(rows):
        y = 118 + i * 46
        small_caps(d, (250, y + 6), label, 20, lab)
        if label == "ID NUMBER":
            value = value.replace("-", "-" + gap, 1)
        if value:
            text(d, (452, y), value, value_font, ink)
    small_caps(d, (250, 448), "Signature of holder", 20, red)
    d.line([(420, 500), (470, 490)], fill=(30, 30, 30), width=2)
    fields = {k: p[k] for k in ["id_number", "surname", "first_names", "date_of_birth", "place_of_birth", "sex", "date_of_issue"]}
    if village:
        fields["village_of_origin"] = village
    return img, fields


def card_metal(p, rng):
    base = rng.randint(150, 185)
    arr = np.full((H, W, 3), base, dtype=np.float32)
    g = np.random.default_rng(rng.randint(0, 10**9))
    arr += g.normal(0, 6, (H, 1, 1))  # brushed lines
    arr += g.normal(0, 3, (H, W, 1))
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    d = ImageDraw.Draw(img)
    engraved = (55, 55, 60)
    highlight = (215, 215, 220)
    f_num, f_txt = font(MONO, 40), font(MONO, 34)
    rows = [p["id_number"], p["surname"], p["first_names"], p["date_of_birth"], p["village_of_origin"]]
    y = 70
    for i, s in enumerate(rows):
        f = f_num if i == 0 else f_txt
        d.text((62, y + 1), s, font=f, fill=highlight)
        d.text((60, y), s, font=f, fill=engraved)
        y += 82
    d.rectangle([12, 12, W - 12, H - 12], outline=(120, 120, 125), width=3)
    fields = {k: p[k] for k in ["id_number", "surname", "first_names", "date_of_birth", "village_of_origin"]}
    return img, fields


TEMPLATES = {"plastic": card_plastic, "metal": card_metal}


# ----- Photographing it -----

def perspective_coeffs(src, dst):
    m = []
    for (x, y), (u, v) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        m.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    a = np.array(m, dtype=np.float64)
    b = np.array(src, dtype=np.float64).reshape(8)
    return np.linalg.solve(a, b).tolist()


def photograph(card, rng):
    """Puts the card on a table, at an angle, as a phone would see it."""
    out_w, out_h = 1600, 1200
    table = Image.new("RGB", (out_w, out_h), tuple(rng.randint(40, 200) for _ in range(3)))
    noise = np.random.default_rng(rng.randint(0, 10**9)).normal(0, 8, (out_h, out_w, 1))
    table = Image.fromarray(np.clip(np.array(table, dtype=np.float32) + noise, 0, 255).astype(np.uint8))

    scale = rng.uniform(1.15, 1.6)
    cw, ch = W * scale, H * scale
    cx = out_w / 2 + rng.uniform(-120, 120)
    cy = out_h / 2 + rng.uniform(-90, 90)
    angle = math.radians(rng.uniform(-6, 6))
    corners = [(-cw / 2, -ch / 2), (cw / 2, -ch / 2), (cw / 2, ch / 2), (-cw / 2, ch / 2)]
    dst = []
    for i, (x, y) in enumerate(corners):
        jx, jy = rng.uniform(-25, 25), rng.uniform(-20, 20)  # perspective: each corner moves a little
        dst.append((cx + x * math.cos(angle) - y * math.sin(angle) + jx, cy + x * math.sin(angle) + y * math.cos(angle) + jy))
    src = [(0, 0), (W, 0), (W, H), (0, H)]
    coeffs = perspective_coeffs(src, dst)
    warped = card.transform((out_w, out_h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", (W, H), 255).transform((out_w, out_h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    table.paste(warped, (0, 0), mask)
    img = table

    # Lighting: brightness, contrast, a glare spot.
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.75, 1.2))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.8, 1.15))
    if rng.random() < 0.5:
        arr = np.array(img, dtype=np.float32)
        gx, gy = rng.uniform(300, 1300), rng.uniform(250, 950)
        yy, xx = np.mgrid[0:out_h, 0:out_w]
        r = rng.uniform(80, 220)
        glare = np.exp(-(((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * r * r)))[..., None] * rng.uniform(60, 150)
        img = Image.fromarray(np.clip(arr + glare, 0, 255).astype(np.uint8))
    if rng.random() < 0.7:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.6)))
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=300)
    ap.add_argument("--out", default="storage/synthetic/ZW")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--types", default="metal,plastic")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    types = [t for t in args.types.split(",") if t in TEMPLATES]
    os.makedirs(os.path.join(args.out, "images"), exist_ok=True)
    with open(os.path.join(args.out, "labels.jsonl"), "w") as labels:
        for i in range(args.count):
            card_type = types[i % len(types)]
            who = person(rng)
            card, fields = TEMPLATES[card_type](who, rng)
            name = f"zw-{card_type}-{i:05d}.jpg"
            photograph(card, rng).save(os.path.join(args.out, "images", name), "JPEG", quality=rng.randint(60, 90))
            row = {"image": f"images/{name}", "country": "ZW", "label": {"card_type": card_type, "fields": fields}}
            labels.write(json.dumps(row) + "\n")
    print(f"Drew {args.count} cards in {args.out}")


if __name__ == "__main__":
    main()
