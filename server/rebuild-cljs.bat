@echo off
cd /d "%~dp0.."
echo [1/2] Compiling ClojureScript...
pushd ui
npx shadow-cljs compile app
set COMPILE_RESULT=%errorlevel%
popd
if %COMPILE_RESULT% neq 0 (
    echo Compile failed. Server not started.
    pause
    exit /b 1
)
echo [2/2] Starting server...
set PGPASSWORD=7297
node "%~dp0index.js"
