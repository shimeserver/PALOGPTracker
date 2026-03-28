// app.json の代わりにこのファイルを使うことで、環境変数をビルド設定に反映できる
// .env ファイルの値が自動的に読み込まれる (Expo SDK 49+)

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    config: {
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
    },
  },
});
