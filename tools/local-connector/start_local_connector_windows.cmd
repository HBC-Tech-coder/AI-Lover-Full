@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\..\.."

if "%AI_LOVER_PAIRING_CODE%"=="" (
  set /p AI_LOVER_PAIRING_CODE=Enter pairing code from web page:
)

if "%AI_LOVER_DEVICE_BRIDGE_URL%"=="" (
  set AI_LOVER_DEVICE_BRIDGE_URL=wss://ai.vituralmodel.com/device-bridge
)

if "%AI_LOVER_DEVICE_NAME%"=="" (
  set AI_LOVER_DEVICE_NAME=%COMPUTERNAME% Local Connector
)

set NODE_EXE=node
if exist "runtime\nodejs\node.exe" set NODE_EXE=runtime\nodejs\node.exe

echo.
echo AI-Lover Local Connector
echo Pairing code: %AI_LOVER_PAIRING_CODE%
echo Cloud bridge: %AI_LOVER_DEVICE_BRIDGE_URL%
echo Node: %NODE_EXE%
echo.

"%NODE_EXE%" tools\local-connector\ai-lover-local-connector.js --bridge "%AI_LOVER_DEVICE_BRIDGE_URL%" --code "%AI_LOVER_PAIRING_CODE%" --name "%AI_LOVER_DEVICE_NAME%"
pause
