"""앱 아이콘 생성 (홈화면 추가 / PWA).

    python3 scripts/make_icons.py

`web/icons/` 에 PNG를 굽는다. 소스가 코드라서 색·모양을 고치면 전 사이즈가
한 번에 다시 나온다 — 디자인 파일을 따로 관리하지 않아도 된다.

디자인 (2026-08-09 신동환 선택):
  상권 영역이 주인공이고 핀은 그 안의 한 점이다. 이 서비스가 실제로 하는
  첫 번째 일이 「이 좌표가 어느 상권 안인가」 판정(locate.js)이라 구성이
  기능과 맞는다.

  ⚠️ 핀 끝(tip)은 반드시 상권 폴리곤 **내부**에 있어야 한다. 시안 단계에서
  두 번 밖으로 나갔는데, 그러면 「이 자리가 이 상권 안에 있다」를 그리려는
  아이콘이 정반대를 그리게 된다. 아래 point_in_poly로 매 실행마다 검사하고
  틀리면 빌드를 멈춘다.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

SS = 4                      # 슈퍼샘플링 (Pillow에는 안티에일리어싱이 없다)
BASE = 512
N = BASE * SS

# web/css/style.css 팔레트와 맞춘다 — 아이콘과 화면이 따로 놀지 않게.
INFO      = (59, 91, 219)   # --info
NAVY_DEEP = (12, 20, 37)
ROAD      = (38, 53, 85)
WHITE     = (255, 255, 255)

THEME_COLOR = "#0c1425"     # manifest의 theme_color와 같은 값

# 상권 경계처럼 보이도록 불규칙하게(정다각형이면 그냥 도형으로 보인다).
# 바운딩박스 중심이 0.5가 되도록 x를 -0.025 옮겨 놓았다.
AREA_POLY = [(0.195, 0.36), (0.395, 0.19), (0.685, 0.25),
             (0.805, 0.50), (0.645, 0.79), (0.305, 0.77)]

PIN_CX, PIN_CY, PIN_R = 0.50, 0.400, 0.078
PIN_TIP = PIN_CY + PIN_R * 3.0


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            if x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
                inside = not inside
    return inside


def _roads(d):
    w = int(N * 0.028)
    for y in (0.19, 0.45, 0.73):
        d.line([(0, N * y), (N, N * y)], fill=ROAD, width=w)
    for x in (0.25, 0.59, 0.86):
        d.line([(N * x, 0), (N * x, N)], fill=ROAD, width=w)
    # 사선 — 서울 골목상권은 대개 큰 길 하나를 끼고 있다
    d.line([(N * -0.05, N * 0.99), (N * 1.05, N * 0.12)],
           fill=ROAD, width=int(N * 0.036))


def _vignette(base):
    """가장자리만 아주 약하게. 강하면 얼룩으로 보인다."""
    g = Image.new("L", (N, N), 255)
    r = N * 0.62
    ImageDraw.Draw(g).ellipse([N / 2 - r, N / 2 - r, N / 2 + r, N / 2 + r], fill=0)
    g = g.filter(ImageFilter.GaussianBlur(N * 0.16)).point(lambda v: int(v * 0.42))
    return Image.composite(Image.new("RGB", (N, N), (0, 0, 0)), base, g)


def _area(img, scale=1.0):
    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pts = [(N * (0.5 + (x - 0.5) * scale), N * (0.5 + (y - 0.5) * scale))
           for x, y in AREA_POLY]
    d.polygon(pts, fill=INFO + (105,))
    d.line(pts + [pts[0]], fill=INFO + (255,),
           width=max(1, int(N * 0.020 * scale)), joint="curve")
    img.alpha_composite(layer)


def _pin(img, scale=1.0):
    cx = N * (0.5 + (PIN_CX - 0.5) * scale)
    cy = N * (0.5 + (PIN_CY - 0.5) * scale)
    r = N * PIN_R * scale
    tip = cy + r * 3.0
    half = r * 0.70
    dx = math.sqrt(max(r * r - half * half, 0.0))
    shape = [(cx - half, cy + dx), (cx + half, cy + dx), (cx, tip)]

    sh = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ds = ImageDraw.Draw(sh)
    ds.polygon(shape, fill=(0, 0, 0, 165))
    ds.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 165))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(N * 0.026)),
                        (0, int(N * 0.020)))

    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    dl.polygon(shape, fill=WHITE + (255,))
    dl.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE + (255,))
    ir = r * 0.40
    dl.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=INFO + (255,))
    img.alpha_composite(layer)


def render(scale=1.0):
    base = Image.new("RGB", (N, N), NAVY_DEEP)
    _roads(ImageDraw.Draw(base))
    img = _vignette(base).convert("RGBA")
    _area(img, scale)
    _pin(img, scale)
    return img.convert("RGB")


def main():
    if not point_in_poly(PIN_CX, PIN_TIP, AREA_POLY):
        raise SystemExit(
            f"❌ 핀 끝({PIN_CX}, {PIN_TIP:.3f})이 상권 폴리곤 밖이다 — "
            "아이콘이 「이 자리가 상권 안」의 반대를 그리게 된다")

    out = pathlib.Path(__file__).resolve().parent.parent / "web" / "icons"
    out.mkdir(parents=True, exist_ok=True)

    full = render()
    # maskable: 안드로이드가 원형 등으로 잘라내므로 내용을 안전영역(80%)에 넣는다.
    # iOS용 apple-touch-icon은 잘리지 않으니 꽉 찬 그림을 그대로 쓴다.
    masked = render(scale=0.80)

    sizes = {"icon-180.png": (full, 180),     # apple-touch-icon
             "icon-192.png": (full, 192),
             "icon-512.png": (full, 512),
             "icon-maskable-512.png": (masked, 512)}
    for name, (src, px) in sizes.items():
        src.resize((px, px), Image.LANCZOS).save(out / name, optimize=True)
        print(f"  {name}  {px}x{px}")

    print(f"✅ {out} 에 아이콘 {len(sizes)}개 생성 (theme_color {THEME_COLOR})")


if __name__ == "__main__":
    main()
