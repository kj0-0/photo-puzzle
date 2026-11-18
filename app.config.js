// GitHub Pages(https://kj0-0.github.io/photo-puzzle/)에 올릴 때만 주소 앞부분을 붙임 (scripts/deploy-web.sh).
// 내 컴퓨터 미리보기(localhost:8081)는 그대로 동작.
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL || '' },
});
