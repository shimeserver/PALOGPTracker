// スポット名からカテゴリを自動判定する（コンビニ・ガソリンスタンド・SA/PA）。
// 名前はNominatim逆ジオコーディングやGoogle Places由来なのでチェーン名が含まれることが多い。
// 判定できない場合は null（呼び出し側で既存カテゴリや「その他」にフォールバック）。

const CONVENIENCE = [
  'セブン-イレブン', 'セブンイレブン', 'セブン‐イレブン', '7-eleven',
  'ファミリーマート', 'ファミマ', 'famima', 'familymart',
  'ローソン', 'lawson',
  'ミニストップ', 'ministop',
  'デイリーヤマザキ', 'ヤマザキショップ', 'daily yamazaki',
  'セイコーマート', 'seicomart',
  'ニューデイズ', 'newdays',
  'ポプラ', 'コミュニティ・ストア',
  'コンビニ',
];

const GAS = [
  'eneos', 'エネオス',
  '出光', 'idemitsu', 'apollostation', 'アポロステーション',
  'コスモ石油', 'コスモ', 'cosmo',
  'シェル', 'shell',
  'キグナス', 'kygnus',
  'ソラト', 'solato', '太陽石油',
  'エッソ', 'esso', 'モービル', 'mobil', 'ゼネラル',
  'ja-ss',
  'ガソリンスタンド', '給油所', 'サービスステーション', ' ss ',
];

// SA/PA: 「三芳PA」「海ほたるPA (上り)」「足柄SA」等。英字2文字は誤爆しやすいので
// 単語末尾（後ろが空白/括弧/文末）に限定して判定する。
const SAPA_WORDS = ['パーキングエリア', 'サービスエリア', 'ハイウェイオアシス'];
const SAPA_SUFFIX = /(PA|SA)([\s（(]|$)/;

export const AUTO_CATEGORIES = ['コンビニ', 'ガソリンスタンド', 'SA/PA'] as const;

export function categorizeByName(name: string): string | null {
  const n = name.toLowerCase();
  if (CONVENIENCE.some(k => n.includes(k.toLowerCase()))) return 'コンビニ';
  if (GAS.some(k => n.includes(k.toLowerCase()))) return 'ガソリンスタンド';
  if (SAPA_WORDS.some(k => n.includes(k.toLowerCase())) || SAPA_SUFFIX.test(name)) return 'SA/PA';
  return null;
}
