@echo off
cd /d "%~dp0.."
echo [1/2] Building React UI...
pushd ui-react
call npm run build
set BUILD_RESULT=%errorlevel%
popd
if %BUILD_RESULT% neq 0 (
    echo Build failed. Server not started.
    pause
    exit /b 1
)
echo [2/2] Starting server...
set PGPASSWORD=7297
node "%~dp0index.js"
