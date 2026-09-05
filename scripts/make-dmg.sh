#!/bin/sh
# Builds the Release app and packs it into a universal dmg in dist/.
set -eu
cd "$(dirname "$0")/.."

# Fall back to the stock Xcode location when xcode-select points at the
# command line tools, which cannot build this project.
if ! xcodebuild -version >/dev/null 2>&1; then
    export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
fi

DERIVED=build/DerivedData
xcodebuild \
    -project JSONReader.xcodeproj \
    -scheme JSONReader \
    -configuration Release \
    -derivedDataPath "$DERIVED" \
    ONLY_ACTIVE_ARCH=NO ARCHS="arm64 x86_64" \
    build

APP="$DERIVED/Build/Products/Release/JSONReader.app"
VERSION="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
OUT="dist/JSONReader-$VERSION-universal.dmg"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

mkdir -p dist
hdiutil create -volname "JSON Reader" -srcfolder "$STAGING" -ov -format UDZO "$OUT"
echo "Created $OUT"
