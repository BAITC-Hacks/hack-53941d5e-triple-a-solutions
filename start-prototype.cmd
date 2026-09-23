@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if not errorlevel 1 (
    node.exe scripts/serve.mjs
    goto finish
)
set "TASK_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%TASK_NODE%" (
    echo Install Node.js 24 or newer, then open this file again.
    goto finish
)
"%TASK_NODE%" scripts/serve.mjs
:finish
pause
endlocal
