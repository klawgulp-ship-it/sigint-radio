#!/bin/bash
# ============================================================
# SIGINT RADIO — Full Setup & Deploy Script
# Run this from your project root
# ============================================================

set -e

echo "╔══════════════════════════════════════════════╗"
echo "║     📡 SIGINT RADIO — Setup & Deploy        ║"
echo "╚══════════════════════════════════════════════╝"

# ─── 1. INIT GIT REPO ────────────────────────────────────────
echo ""
echo "── [1/6] Initializing git repo..."
git init
git add -A
git commit -m "init: SIGINT Radio — global frequency intelligence platform"

# ─── 2. GITHUB REPO ──────────────────────────────────────────
echo ""
echo "── [2/6] Creating GitHub repo..."
# Using GitHub CLI — install with: brew install gh
gh repo create sigint-radio --public --source=. --push
# If gh isn't installed, do it manually:
# git remote add origin git@github.com:klawgulp-ship-it/sigint-radio.git
# git push -u origin main

# ─── 3. INSTALL DEPS LOCALLY ─────────────────────────────────
echo ""
echo "── [3/6] Installing dependencies..."
npm install

# ─── 4. TEST LOCAL BUILD ─────────────────────────────────────
echo ""
echo "── [4/6] Testing build..."
npm run build
echo "✅ Build successful"

# ─── 5. DEPLOY TO RAILWAY (FRONTEND) ─────────────────────────
echo ""
echo "── [5/6] Deploying frontend to Railway..."
# Install Railway CLI if needed: npm install -g @railway/cli
railway login
railway init --name sigint-radio
railway up

echo ""
echo "── [6/6] Done! ──────────────────────────────────"
echo ""
echo "📡 Frontend deployed to Railway"
echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  NEXT STEPS FOR PRODUCTION:                     │"
echo "│                                                 │"
echo "│  1. Deploy ingestion server:                    │"
echo "│     cd server && railway init && railway up     │"
echo "│                                                 │"
echo "│  2. Set env vars on Railway:                    │"
echo "│     railway variables set ANTHROPIC_API_KEY=... │"
echo "│     railway variables set DATABASE_URL=...      │"
echo "│     railway variables set WHISPER_URL=...       │"
echo "│                                                 │"
echo "│  3. Add PostgreSQL on Railway:                  │"
echo "│     railway add --plugin postgresql             │"
echo "│                                                 │"
echo "│  4. For Whisper STT, options:                   │"
echo "│     a) Self-host faster-whisper on GPU box      │"
echo "│     b) Use Groq Whisper API (fastest)           │"
echo "│     c) Use OpenAI Whisper API                   │"
echo "│     d) Replicate.com whisper-large-v3           │"
echo "│                                                 │"
echo "│  5. For more streams, check:                    │"
echo "│     - radio.garden (unofficial API)             │"
echo "│     - websdr.org (HF/VHF receivers)             │"
echo "│     - broadcastify.com (scanner feeds)          │"
echo "│     - openwebrx.de (SDR receivers)              │"
echo "└─────────────────────────────────────────────────┘"
