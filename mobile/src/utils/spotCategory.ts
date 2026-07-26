// スポット名からカテゴリを自動判定する（Web版 web/src/utils/spotCategory.ts と同一ロジック）。
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
  'コスモ石油', 'cosmo石油',  // 素の「コスモ」は「コスモス薬品」等に誤爆するため不可
  '昭和シェル', 'シェル石油', 'shell', // 素の「シェル」は「ミッシェル」等に誤爆するため不可
  'キグナス', 'kygnus',
  'ソラト', 'solato', '太陽石油',
  'エッソ', 'esso', 'モービル', 'mobil', 'ゼネラル石油',
  'ja-ss',
  'ガソリンスタンド', '給油所', 'サービスステーション', ' ss ',
];

// SA/PA: 「三芳PA」「海ほたるPA (上り)」等。英字2文字は誤爆しやすいので
// 「直前が英字でない」かつ単語末尾に限定（"MELSA"等の英単語末尾を拾わない）。
const SAPA_WORDS = ['パーキングエリア', 'サービスエリア', 'ハイウェイオアシス'];
const SAPA_SUFFIX = /(^|[^A-Za-z])(PA|SA)([\s（(]|$)/;

// アプリ全体で使うスポットカテゴリの正準リスト（Web版と同一）
export const SPOT_CATEGORIES = ['その他', 'グルメ', 'カフェ', 'コンビニ', '観光', '公園', 'ショッピング', 'ガソリンスタンド', 'SA/PA', '駐車場'];

export function categorizeByName(name: string): string | null {
  const n = name.toLowerCase();
  if (CONVENIENCE.some(k => n.includes(k.toLowerCase()))) return 'コンビニ';
  if (GAS.some(k => n.includes(k.toLowerCase()))) return 'ガソリンスタンド';
  if (SAPA_WORDS.some(k => n.includes(k.toLowerCase())) || SAPA_SUFFIX.test(name)) return 'SA/PA';
  return null;
}

// 地図マーカー用: カテゴリ→絵文字（Web版のアイコン分けと同じ体系）
export function categoryEmoji(category: string): string {
  if (category === 'コンビニ') return '🏪';
  if (category === 'ガソリンスタンド') return '⛽';
  if (category === 'SA/PA') return '🅿️';
  return '★';
}
