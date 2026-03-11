#!/bin/bash
# Deploy script: build, deploy to nginx, commit & push to GitHub
set -e

cd /var/www/fitbake-tracker

echo "=== Building project ==="
npx vite build

echo "=== Deploying to nginx ==="
cp -r dist/* /var/www/html/

echo "=== Pushing to GitHub ==="
# Check if there are any changes to commit
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "No changes to commit."
else
    git add -A
    git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin master
    echo "Changes pushed to GitHub."
fi

echo "=== Deploy complete ==="
