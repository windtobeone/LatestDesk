#!/bin/bash
# Exit on any error
set -e

echo "=== Starting Flutter Web Compilation ==="

# 0. Build JS Bridge via Vite
echo "Building JS Bridge via Vite..."
cd /home/test03/dev/latestdesk/flutter/web/js
npx vite build
cd /home/test03/dev/latestdesk/flutter

# 1. Compile Conventional Web Client
echo "Building Conventional Web Client (--base-href /web/)..."
flutter build web --base-href "/web/" --web-renderer canvaskit

echo "Syncing Conventional Web Client assets to Umi Web Pro..."
mkdir -p /home/test03/rustdesk-web-pro/public/web
cp -r build/web/* /home/test03/rustdesk-web-pro/public/web/
mkdir -p /home/test03/rustdesk-web-pro/dist/web
cp -r build/web/* /home/test03/rustdesk-web-pro/dist/web/

# 2. Compile Monitor Dashboard Web Client
echo "Building Monitor Dashboard Web Client (--base-href /web-monitor/)..."
flutter build web --base-href "/web-monitor/" --web-renderer canvaskit

echo "Syncing Monitor Dashboard Web Client assets to Umi Web Pro..."
mkdir -p /home/test03/rustdesk-web-pro/public/web-monitor
cp -r build/web/* /home/test03/rustdesk-web-pro/public/web-monitor/
mkdir -p /home/test03/rustdesk-web-pro/dist/web-monitor
cp -r build/web/* /home/test03/rustdesk-web-pro/dist/web-monitor/

# 3. Post-processing: Insert monitor-bootstrap.js script tag in web-monitor index.html files
echo "Inserting monitor-bootstrap.js tag in web-monitor index.html files..."
python3 -c "
for path in ['/home/test03/rustdesk-web-pro/public/web-monitor/index.html', '/home/test03/rustdesk-web-pro/dist/web-monitor/index.html']:
    content = open(path).read()
    if 'monitor-bootstrap.js' not in content:
        content = content.replace('<head>', '<head>\n  <script src=\"js/dist/monitor-bootstrap.js\"></script>')
        open(path, 'w').write(content)
        print('Updated tag in:', path)
    else:
        print('Tag already exists in:', path)
"

echo "=== Flutter Web Compilation Finished Successfully ==="
