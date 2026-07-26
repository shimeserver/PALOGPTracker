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

// アプリ全体で使うスポットカテゴリの正準リスト
export const SPOT_CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', 'SA/PA', '駐車場'];

// Google Places の types からカテゴリを判定。
// コンビニ・ガソスタを先に判定する（コンビニは types に 'food' を含むことが多く、
// グルメ判定を先にすると全部グルメに化ける）。
export function placeTypeToCategory(types: string[]): string {
  if (types.includes('convenience_store')) return 'コンビニ';
  if (types.includes('gas_station')) return 'ガソリンスタンド';
  if (types.includes('restaurant') || types.includes('food') || types.includes('bakery') || types.includes('meal_takeaway')) return 'グルメ';
  if (types.includes('cafe')) return 'カフェ';
  if (types.includes('tourist_attraction') || types.includes('museum') || types.includes('amusement_park') || types.includes('shrine') || types.includes('temple')) return '観光';
  if (types.includes('park') || types.includes('campground')) return '公園';
  if (types.includes('shopping_mall') || types.includes('store') || types.includes('clothing_store') || types.includes('department_store')) return 'ショッピング';
  if (types.includes('parking')) return '駐車場';
  return 'その他';
}

export function categorizeByName(name: string): string | null {
  const n = name.toLowerCase();
  if (CONVENIENCE.some(k => n.includes(k.toLowerCase()))) return 'コンビニ';
  if (GAS.some(k => n.includes(k.toLowerCase()))) return 'ガソリンスタンド';
  if (SAPA_WORDS.some(k => n.includes(k.toLowerCase())) || SAPA_SUFFIX.test(name)) return 'SA/PA';
  return null;
}
