@echo off
title DreamVision Backend Server
color 0B
echo.
echo  ================================================
echo   DreamVision Backend - Starting on port 8000
echo  ================================================
echo.
cd /d "%~dp0backend"
uvicorn main:app --reload --port 8000
pause
