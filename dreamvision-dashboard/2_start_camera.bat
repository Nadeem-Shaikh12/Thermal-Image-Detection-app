@echo off
title DreamVision Camera / Simulator
color 0A
echo.
echo  ================================================
echo   DreamVision Smart Launcher
echo   Auto-detects ESP32 camera on WiFi
echo  ================================================
echo.
echo  - If your PC is connected to the ESP32 WiFi:
echo    It will stream LIVE thermal data
echo.
echo  - Otherwise: simulator runs automatically
echo  ================================================
echo.
cd /d "%~dp0"
python start.py
pause
