// RaceBox Mini / Mini S / Micro の BLE データパケット解析。
// 公式プロトコル (RaceBox Protocol Description) に準拠:
//   フレーム: 0xB5 0x62 | class(1) | id(1) | length(2, LE) | payload(length) | ck_a ck_b
//   データメッセージ: class=0xFF id=0x01 length=80（既定 25Hz で送信される）
//   チェックサム: class〜payload末尾までの 8bit Fletcher

export interface RaceBoxFix {
  timestamp: number;     // UTC epoch ms（GNSS時刻が無効なら端末時刻）
  lat: number;
  lng: number;
  altitude: number;      // MSL 高度 (m)
  speed: number;         // m/s
  heading: number;       // deg
  hAcc: number;          // 水平精度 (m)
  satellites: number;
  fixType: number;       // 0=no fix, 2=2D, 3=3D
  validFix: boolean;     // 3D かつ gnssFixOK
  battery: number | null; // %（不明なら null）
  charging: boolean;
}

const HEADER_1 = 0xb5;
const HEADER_2 = 0x62;
const DATA_CLASS = 0xff;
const DATA_ID = 0x01;
const DATA_LEN = 80;
const MAX_PAYLOAD = 512; // 異常な length でバッファが詰まるのを防ぐ上限

function parseDataPayload(p: DataView): RaceBoxFix {
  const year = p.getUint16(4, true);
  const month = p.getUint8(6);
  const day = p.getUint8(7);
  const hour = p.getUint8(8);
  const minute = p.getUint8(9);
  const second = p.getUint8(10);
  const validity = p.getUint8(11);
  const nano = p.getInt32(16, true);
  const fixType = p.getUint8(20);
  const fixFlags = p.getUint8(21);
  const satellites = p.getUint8(23);
  const lng = p.getInt32(24, true) / 1e7;
  const lat = p.getInt32(28, true) / 1e7;
  const altMsl = p.getInt32(36, true) / 1000;
  const hAcc = p.getUint32(40, true) / 1000;
  const speed = p.getInt32(48, true) / 1000;
  const heading = p.getInt32(52, true) / 1e5;
  const batt = p.getUint8(67);

  // bit0: 日付有効, bit1: 時刻有効
  const timeValid = (validity & 0x03) === 0x03 && year >= 2020;
  const timestamp = timeValid
    ? Date.UTC(year, month - 1, day, hour, minute, second) + Math.round(nano / 1e6)
    : Date.now();

  return {
    timestamp,
    lat, lng,
    altitude: altMsl,
    speed: Math.max(0, speed),
    heading,
    hAcc,
    satellites,
    fixType,
    validFix: fixType === 3 && (fixFlags & 0x01) === 0x01,
    battery: (batt & 0x7f) <= 100 ? batt & 0x7f : null,
    charging: (batt & 0x80) !== 0,
  };
}

/**
 * BLE 通知はパケット境界と一致しない（分割・結合される）ため、
 * バイトを蓄積してフレーム単位で取り出すストリームパーサ。
 */
export class RaceBoxStreamParser {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): RaceBoxFix[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: RaceBoxFix[] = [];
    let i = 0;
    while (i + 8 <= merged.length) {
      if (merged[i] !== HEADER_1 || merged[i + 1] !== HEADER_2) { i++; continue; }
      const len = merged[i + 4] | (merged[i + 5] << 8);
      if (len > MAX_PAYLOAD) { i++; continue; } // ヘッダ誤検出
      const frameLen = 6 + len + 2;
      if (i + frameLen > merged.length) break; // 続きを待つ
      let ckA = 0, ckB = 0;
      for (let k = i + 2; k < i + 6 + len; k++) {
        ckA = (ckA + merged[k]) & 0xff;
        ckB = (ckB + ckA) & 0xff;
      }
      if (ckA !== merged[i + 6 + len] || ckB !== merged[i + 7 + len]) { i++; continue; }
      const cls = merged[i + 2], id = merged[i + 3];
      if (cls === DATA_CLASS && id === DATA_ID && len === DATA_LEN) {
        out.push(parseDataPayload(new DataView(merged.buffer, merged.byteOffset + i + 6, len)));
      }
      i += frameLen;
    }
    this.buf = merged.slice(i);
    if (this.buf.length > 4096) this.buf = new Uint8Array(0); // 念のため
    return out;
  }

  reset() { this.buf = new Uint8Array(0); }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** ble-plx は値を base64 文字列で渡すためバイト列へ変換 */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = ((acc << 6) | B64_LOOKUP[clean.charCodeAt(i)]) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
