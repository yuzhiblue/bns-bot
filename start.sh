#!/bin/bash
# bns-bot 开机自启脚本 (Ubuntu)
cd "$(dirname "$0")"
exec >> "$(dirname "$0")/bot.log" 2>&1
node bot.js
