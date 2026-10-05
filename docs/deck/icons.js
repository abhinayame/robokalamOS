const sharp = require('sharp'); const out = '/home/user/robokalamos/web/public/icons/';
const svg = (size, radius, pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#f5a524"/><text x="50%" y="50%" dy="${size * 0.07}" text-anchor="middle" dominant-baseline="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size * (1 - 2 * pad) * 0.78}" fill="#12263f">R</text></svg>`;
(async () => {
  await sharp(Buffer.from(svg(512, 112, 0.14))).png().toFile(out + 'icon-512.png');
  await sharp(Buffer.from(svg(192, 42, 0.14))).png().toFile(out + 'icon-192.png');
  await sharp(Buffer.from(svg(180, 0, 0.14))).png().toFile(out + 'apple-touch-icon.png');          // iOS rounds the corners itself
  await sharp(Buffer.from(svg(512, 0, 0.22))).png().toFile(out + 'maskable-512.png');               // full bleed, glyph inside the safe zone
  console.log('icons written');
})();
