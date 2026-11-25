@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Aktualizuji yt-dlp...
python -m pip install -q -U "yt-dlp[default]"
start "" "http://127.0.0.1:5174/"
python helper\kytara_helper.py
pause
