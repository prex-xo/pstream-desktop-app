#!/bin/bash

# ============================================================
#  P-Stream Electron App - Build Script
# ============================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

APP_DIR="/Users/pranav/MacTempMonitor/pstream-electron"
export PATH="/opt/homebrew/bin:$PATH"

echo -e "\n${BOLD}Building P-Stream...${NC}\n"

cd "$APP_DIR"
npm install

echo ""
echo -e "What do you want to build?"
echo -e "  ${CYAN}1${NC}) macOS only (default)"
echo -e "  ${CYAN}2${NC}) All platforms (mac + win + linux)"
echo ""
read -r -p "Choice [1]: " CHOICE
CHOICE=${CHOICE:-1}

if [[ "$CHOICE" == "2" ]]; then
  npm run build:all
else
  npm run build:mac
fi

# Install to Applications on mac
APP_PATH=$(find "$APP_DIR/dist" -name "*.app" -maxdepth 3 2>/dev/null | head -1)
if [ -n "$APP_PATH" ]; then
  echo -e "\n${GREEN}Installing to /Applications...${NC}"
  rm -rf "/Applications/P-Stream.app" 2>/dev/null || true
  cp -r "$APP_PATH" "/Applications/P-Stream.app"
  echo -e "${GREEN}✓ Installed!${NC}"
  echo ""
  read -r -p "Open P-Stream now? (y/n): " OPEN
  if [[ "$OPEN" == "y" || "$OPEN" == "Y" ]]; then
    open "/Applications/P-Stream.app"
  fi
fi

echo -e "\n${GREEN}Done! Built files are in: ${CYAN}$APP_DIR/dist${NC}\n"
