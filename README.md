# 🚀 DeepSeek-Warp

**Developed by Ahmed elshamey | بواسطة أحمد الشامي**

An advanced, OpenAI-compatible API Gateway for DeepSeek. This project allows you to transform a standard DeepSeek web account into a professional API service with multi-tenant management, rate limiting, and IP isolation.

## ✨ Key Features

- **Multi-Instance Management:** Create and manage multiple independent API endpoints from a single management hub.
- **OpenAI Compatibility:** Fully compatible with **Hermes Agent**, Open WebUI, LangChain, and any other OpenAI-standard client.
- **Tool Calling Support:** Simulates OpenAI function calling via prompt injection and response parsing, enabling the model to use external tools and functions.
- **Dynamic Rate Limiting:** Set precise limits per API key (Messages per minute, hour, day, and month).
- **IP Isolation (Tor Mode):** Integrated Tor support to assign different exit IPs to different instances, bypassing rate limits and blocking.
- **Live Configuration:** Edit API limits, expiration dates, and model visibility in real-time without restarting the server.
- **Smart Rendering:** High-fidelity DOM-to-Markdown conversion, preserving tables, lists, and code blocks.
- **Reasoning Capture:** Full support for DeepSeek's "Thinking" process (Reasoning content).
- **Automated Provisioning:** One-click setup script for fresh Linux servers.

## 🛠️ Technical Stack

- **Runtime:** Node.js (LTS)
- **Automation:** Playwright (Chromium)
- **Process Management:** PM2
- **Proxy:** Tor (Optional)
- **API Standard:** OpenAI Chat Completions API

## 🚀 Quick Start

### 1. Installation
Run the ultimate setup script on a clean Ubuntu/Debian server:

```bash
# Install prerequisites
sudo apt-get update && sudo apt-get install -y git curl

# Clone the repository
git clone https://github.com/ahmed-elshamey/deepseek-warp.git
cd deepseek-warp

# Make setup script executable and run it
chmod +x setup.sh
sudo ./setup.sh
```

### 2. Create a New API
```bash
cd /var/www/ai-deepseek/manager
node create-api.mjs
```
Follow the interactive prompts to set up your credentials, port, and limits.

### 3. Manage Your APIs
Use the management script to control your instances:
```bash
node manage-api.mjs [command] [name]
```

**Available Commands:**
- `list` (or `ls`, `l`): List all active API instances.
- `info <name>` (or `i`, `show`): Show detailed configuration and usage stats.
- `key <name>` (or `k`): Retrieve the API key for a specific instance.
- `start <name>` (or `s`): Start a stopped API instance.
- `stop <name>` (or `x`): Stop a running API instance.
- `restart <name>` (or `r`): Restart an instance.
- `delete <name>` (or `del`, `rm`): Permanently delete an instance and its data.
- `logs <name>` (or `log`): View the last 50 lines of the instance logs.
- `edit`: Open the interactive editor for rate limits and config.
- `start-all`: Start all registered instances.
- `stop-all`: Stop all registered instances.

## 📖 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | `POST` | Chat completion (OpenAI compatible) |
| `/v1/models` | `GET` | List available models |
| `/health` | `GET` | Check instance health & browser status |
| `/v1/api-info` | `GET` | Get API key details and limits |

## ⚠️ Warning

This project is created for **educational purposes** and to demonstrate the power of browser automation. Please use it responsibly and respect the Terms of Service of the providers.

---
Built by Ahmed elshamey for the AI Community | صنع بواسطة أحمد الشامي لمجتمع الذكاء الاصطناعي
