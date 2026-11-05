"""Raster variants of the repository's authored two-ring icon.svg (Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'apps/web/public'
for name, size, maskable in [('apple-touch-icon', 180, False), ('icon-192', 192, False),
                              ('icon-512', 512, False), ('icon-maskable-512', 512, True)]:
    scale = size * 4 / 64
    image = Image.new('RGB', (size * 4, size * 4), '#0060c9')
    draw = ImageDraw.Draw(image)
    # Entire mark inside the central safe circle for the maskable variant.
    factor = 0.78 if maskable else 1
    def p(value):
        return (32 + (value - 32) * factor) * scale
    for center, color in [(25, '#ffffff'), (39, '#ccdff4')]:
        draw.ellipse((p(center - 12), p(20), p(center + 12), p(44)),
                     outline=color, width=round(5 * factor * scale))
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'{name}.png')
