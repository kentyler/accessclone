@echo off
cd /d "%~dp0.."
echo [1/2] Building React UI...
pushd ui-react
call npm run build
set COMPILE_RESULT=%errorlevel%
popd
if %COMPILE_RESULT% neq 0 (
    echo Build failed. Server not started.
    pause
    exit /b 1
)
echo [2/2] Starting server with React UI...
set PGPASSWORD=7297
set USE_REACT_UI=1
node "%~dp0index.js"
