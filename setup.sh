#!/bin/bash
# DeepSeek API Manager - Ultimate Setup Script
# This script transforms a fresh Linux server into a fully functional DeepSeek API host.

set -e # Exit immediately if a command exits with a non-zero status

# Colors for better UX
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║            🚀 DEEPSEEK API MANAGER - ULTIMATE PROVISIONING                ║"
echo "║        Installs everything from scratch: Node.js, PM2, Playwright, Tor    ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝${NC}"

# 1. Ensure we are root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}❌ Please run as root (use sudo bash setup.sh)${NC}"
  exit 1
fi

# 2. Update System and Install Base Tools
echo -e "\n${YELLOW}── Step 1: Installing base system tools...${NC}"
apt-get update -qq
apt-get install -y -qq curl wget git gnupg ca-certificates lsb-release build-essential -qq
echo -e "${GREEN}  ✅ Base tools installed (curl, wget, git, etc.)${NC}"

# 3. Install Node.js (LTS)
if ! command -v node &> /dev/null; then
    echo -e "\n${YELLOW}── Step 2: Installing Node.js LTS...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    echo -e "${GREEN}  ✅ Node.js installed: $(node -v)${NC}"
else
    echo -e "\n${GREEN}  ✅ Node.js already installed: $(node -v)${NC}"
fi

# 4. Install PM2 and Global Dependencies
if ! command -v pm2 &> /dev/null; then
    echo -e "\n${YELLOW}── Step 3: Installing PM2 and Global Dependencies...${NC}"
    npm install -g pm2 playwright
    echo -e "${GREEN}  ✅ PM2 and Playwright installed globally${NC}"
else
    echo -e "${GREEN}  ✅ PM2 already installed${NC}"
fi

# 5. Playwright Installation & Browser Dependencies
echo -e "\n${YELLOW}── Step 4: Setting up Playwright & Browser Dependencies...${NC}"
# Install playwright globally
npm install -g playwright

# CRITICAL: Install the system libraries required for browsers to run
echo -e "${BLUE}  Installing system dependencies for Chromium... (this may take a few minutes)${NC}"
npx playwright install-deps chromium

# Install the actual Chromium browser binary
echo -e "${BLUE}  Downloading Chromium binary...${NC}"
npx playwright install chromium

echo -e "${GREEN}  ✅ Playwright and Chromium are ready to go${NC}"

# 6. Tor Installation & Configuration
if ! command -v tor &> /dev/null; then
    echo -e "\n${YELLOW}── Step 5: Installing Tor for IP Isolation...${NC}"
    apt-get install -y -qq tor
    systemctl enable tor
    systemctl start tor
    echo -e "${GREEN}  ✅ Tor installed and started${NC}"
else
    echo -e "${GREEN}  ✅ Tor already installed${NC}"
fi

# 7. Directory Structure Setup
echo -e "\n${YELLOW}── Step 6: Creating directory structure...${NC}"
mkdir -p /var/www/ai-deepseek/manager
mkdir -p /var/www/ai-deepseek/me-panel
echo -e "${GREEN}  ✅ Directories created: /var/www/ai-deepseek/${NC}"

# 8. Copying Management Scripts
echo -e "\n${YELLOW}── Step 7: Deploying management scripts...${NC}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# List of files to copy
FILES=("server.mjs" "create-api.mjs" "manage-api.mjs" "edit-api.mjs")

for FILE in "${FILES[@]}"; do
    if [ -f "$SCRIPT_DIR/$FILE" ]; then
        cp "$SCRIPT_DIR/$FILE" "/var/www/ai-deepseek/manager/$FILE"
        echo -e "${GREEN}  ✅ Copied $FILE${NC}"
    else
        echo -e "${RED}  ❌ Error: $FILE not found in $SCRIPT_DIR${NC}"
        exit 1
    fi
done

echo -e "\n${BLUE}"
echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║                   🎉 SETUP COMPLETED SUCCESSFULLY!                       ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝${NC}"
echo -e "\n${BOLD}Next Steps:${NC}"
echo -e "1. ${BLUE}Create your first API:${NC}"
echo -e "   cd /var/www/ai-deepseek/manager"
echo -e "   node create-api.mjs"
echo -e "\n2. ${BLUE}Manage your instances:${NC}"
echo -e "   node manage-api.mjs list"
echo -e "\n${DIM}All dependencies including Playwright system libs and Tor are installed.${NC}"
