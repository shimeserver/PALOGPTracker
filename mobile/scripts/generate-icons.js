const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const assetsDir = path.join(__dirname, '../assets');

// メインアイコン SVG（1024x1024）
// モダンフラットデザイン: ダークネイビー背景 + GPS ピン + スピードメーター
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f172a"/>
      <stop offset="100%" style="stop-color:#1e293b"/>
    </linearGradient>
  </defs>
  <!-- 背景 -->
  <rect width="1024" height="1024" rx="200" fill="url(#bg)"/>

  <!-- 道路 (下部) -->
  <path d="M 180 820 Q 512 680 844 820" stroke="#1d4ed8" stroke-width="48" fill="none" stroke-linecap="round" opacity="0.5"/>
  <path d="M 220 870 Q 512 730 804 870" stroke="#2563eb" stroke-width="32" fill="none" stroke-linecap="round" opacity="0.35"/>

  <!-- GPS ピン -->
  <ellipse cx="512" cy="760" rx="60" ry="18" fill="#1d4ed8" opacity="0.5"/>
  <path d="M 512 280 C 390 280 300 370 300 470 C 300 600 512 760 512 760 C 512 760 724 600 724 470 C 724 370 634 280 512 280 Z" fill="#2563eb"/>
  <path d="M 512 290 C 395 290 310 375 310 470 C 310 595 512 748 512 748 C 512 748 714 595 714 470 C 714 375 629 290 512 290 Z" fill="#3b82f6"/>
  <!-- ピン内側の円 -->
  <circle cx="512" cy="460" r="90" fill="#0f172a"/>
  <circle cx="512" cy="460" r="68" fill="#60a5fa"/>
  <!-- 速度計アイコン (ピン内) -->
  <circle cx="512" cy="460" r="50" fill="#1e40af"/>
  <path d="M 476 480 L 512 445 L 525 468" stroke="#e0f2fe" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="512" cy="468" r="7" fill="#e0f2fe"/>

  <!-- 右上の小さなドット装飾 -->
  <circle cx="740" cy="230" r="12" fill="#3b82f6" opacity="0.6"/>
  <circle cx="780" cy="200" r="7" fill="#60a5fa" opacity="0.4"/>
  <circle cx="720" cy="195" r="5" fill="#93c5fd" opacity="0.3"/>
</svg>`;

// アダプティブアイコン フォアグラウンド (中央にアイコン)
const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 432" width="432" height="432">
  <!-- GPS ピン (中央) -->
  <ellipse cx="216" cy="340" rx="38" ry="12" fill="#1d4ed8" opacity="0.5"/>
  <path d="M 216 80 C 143 80 88 138 88 200 C 88 286 216 360 216 360 C 216 360 344 286 344 200 C 344 138 289 80 216 80 Z" fill="#2563eb"/>
  <path d="M 216 88 C 147 88 96 143 96 200 C 96 282 216 352 216 352 C 216 352 336 282 336 200 C 336 143 285 88 216 88 Z" fill="#3b82f6"/>
  <circle cx="216" cy="192" r="56" fill="#0f172a"/>
  <circle cx="216" cy="192" r="42" fill="#60a5fa"/>
  <circle cx="216" cy="192" r="30" fill="#1e40af"/>
  <path d="M 196 208 L 216 185 L 224 200" stroke="#e0f2fe" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="216" cy="200" r="5" fill="#e0f2fe"/>
</svg>`;

// アダプティブアイコン バックグラウンド
const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 432" width="432" height="432">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0f172a"/>
      <stop offset="100%" style="stop-color:#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="432" height="432" fill="url(#bg)"/>
  <path d="M 40 380 Q 216 300 392 380" stroke="#1d4ed8" stroke-width="20" fill="none" stroke-linecap="round" opacity="0.4"/>
  <path d="M 60 410 Q 216 330 372 410" stroke="#2563eb" stroke-width="14" fill="none" stroke-linecap="round" opacity="0.25"/>
</svg>`;

// モノクロ（通知用）
const monochromeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 432" width="432" height="432">
  <path d="M 216 60 C 130 60 62 128 62 210 C 62 310 216 390 216 390 C 216 390 370 310 370 210 C 370 128 302 60 216 60 Z" fill="white"/>
  <circle cx="216" cy="200" r="65" fill="#0f172a"/>
  <circle cx="216" cy="200" r="48" fill="white"/>
  <circle cx="216" cy="200" r="32" fill="#0f172a"/>
  <path d="M 198 215 L 216 194 L 224 208" stroke="white" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="216" cy="208" r="5" fill="white"/>
</svg>`;

// スプラッシュアイコン
const splashSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M 100 10 C 55 10 18 47 18 90 C 18 148 100 195 100 195 C 100 195 182 148 182 90 C 182 47 145 10 100 10 Z" fill="#2563eb"/>
  <path d="M 100 18 C 59 18 26 51 26 90 C 26 144 100 187 100 187 C 100 187 174 144 174 90 C 174 51 141 18 100 18 Z" fill="#3b82f6"/>
  <circle cx="100" cy="84" r="38" fill="#0f172a"/>
  <circle cx="100" cy="84" r="28" fill="#60a5fa"/>
  <circle cx="100" cy="84" r="18" fill="#1e40af"/>
  <path d="M 87 93 L 100 78 L 107 89" stroke="#e0f2fe" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="100" cy="89" r="4" fill="#e0f2fe"/>
</svg>`;

async function generate() {
  console.log('アイコン生成中...');

  // icon.png (1024x1024)
  await sharp(Buffer.from(iconSvg)).png().toFile(path.join(assetsDir, 'icon.png'));
  console.log('✓ icon.png');

  // splash-icon.png (200x200)
  await sharp(Buffer.from(splashSvg)).resize(200, 200).png().toFile(path.join(assetsDir, 'splash-icon.png'));
  console.log('✓ splash-icon.png');

  // adaptive icon foreground (432x432)
  await sharp(Buffer.from(foregroundSvg)).resize(432, 432).png().toFile(path.join(assetsDir, 'android-icon-foreground.png'));
  console.log('✓ android-icon-foreground.png');

  // adaptive icon background (432x432)
  await sharp(Buffer.from(backgroundSvg)).resize(432, 432).png().toFile(path.join(assetsDir, 'android-icon-background.png'));
  console.log('✓ android-icon-background.png');

  // monochrome (432x432)
  await sharp(Buffer.from(monochromeSvg)).resize(432, 432).png().toFile(path.join(assetsDir, 'android-icon-monochrome.png'));
  console.log('✓ android-icon-monochrome.png');

  // favicon (48x48)
  await sharp(Buffer.from(iconSvg)).resize(48, 48).png().toFile(path.join(assetsDir, 'favicon.png'));
  console.log('✓ favicon.png');

  console.log('完了！');
}

generate().catch(console.error);
