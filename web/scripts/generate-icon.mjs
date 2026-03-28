import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '../src/assets');

// Red/white "P" icon — same flat design as the reference
// Dark red background (#b91c1c), white letter P
const SIZE = 256;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">
  <!-- Background: dark red with slight rounded square feel -->
  <rect width="256" height="256" fill="#7f1d1d"/>
  <!-- Inner background square (inset border effect) -->
  <rect x="12" y="12" width="232" height="232" fill="#991b1b"/>
  <!-- Letter P: white, bold, centered -->
  <text
    x="128"
    y="185"
    font-family="Arial, Helvetica, sans-serif"
    font-weight="900"
    font-size="188"
    text-anchor="middle"
    fill="#ffffff"
    letter-spacing="-4"
  >P</text>
  <!-- Subtle shadow/depth on P -->
  <text
    x="132"
    y="189"
    font-family="Arial, Helvetica, sans-serif"
    font-weight="900"
    font-size="188"
    text-anchor="middle"
    fill="rgba(0,0,0,0.18)"
    letter-spacing="-4"
  >P</text>
  <text
    x="128"
    y="185"
    font-family="Arial, Helvetica, sans-serif"
    font-weight="900"
    font-size="188"
    text-anchor="middle"
    fill="#ffffff"
    letter-spacing="-4"
  >P</text>
</svg>`;

const svgBuffer = Buffer.from(svg);

// Generate sizes needed for .ico: 16, 32, 48, 64, 128, 256
const sizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = await Promise.all(
  sizes.map(s => sharp(svgBuffer).resize(s, s).png().toBuffer())
);

// Save the 256x256 PNG as icon.png
writeFileSync(path.join(assetsDir, 'icon.png'), pngBuffers[pngBuffers.length - 1]);
console.log('icon.png saved');

// Generate .ico with all sizes
const icoBuffer = await pngToIco(pngBuffers);
writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer);
console.log('icon.ico saved');
