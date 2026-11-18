#!/bin/sh
# 웹 버전을 만들어 gh-pages 브랜치에 올림 → https://kj0-0.github.io/photo-puzzle/
# 사용법: npm run deploy
set -e
cd "$(dirname "$0")/.."
rm -rf dist
EXPO_BASE_URL=/photo-puzzle npx expo export -p web
touch dist/.nojekyll   # _expo 폴더가 무시되지 않게
cd dist
git init -q -b gh-pages
git add -A
git commit -qm "웹 배포 $(date '+%Y-%m-%d %H:%M')"
git push -f https://github.com/kj0-0/photo-puzzle.git gh-pages
cd .. && rm -rf dist
echo "올렸어요. 1~2분 뒤 https://kj0-0.github.io/photo-puzzle/ 에서 확인하세요."
