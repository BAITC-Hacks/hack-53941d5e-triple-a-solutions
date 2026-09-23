@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "CQ_NODE=node.exe"
where node.exe >nul 2>nul
if errorlevel 1 set "CQ_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%CQ_NODE%"=="node.exe" if not exist "%CQ_NODE%" (
    echo Нужен Node.js 22 или новее. Инструкция: docs\connect-ai.md
    pause
    exit /b 1
)
echo Проверка трёх AI-функций на вымышленных данных.
echo При подключённом AI будет до трёх платных запросов. Ключ в окне не показывается.
echo.
"%CQ_NODE%" scripts/check-ai-workflows.mjs --live
set "CQ_EXIT=%errorlevel%"
echo.
if "%CQ_EXIT%"=="0" (
    echo Проверка пройдена. Откройте отчёт artifacts\ai-workflows-live.json.
) else (
    echo Проверка не пройдена. Посмотрите сообщение выше и docs\connect-ai.md.
)
pause
exit /b %CQ_EXIT%
