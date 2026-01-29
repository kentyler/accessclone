#!/bin/bash
# Start PolyAccess server (runs in Windows to access Windows PostgreSQL)

# Kill any existing node server on port 3001
powershell.exe -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null

echo "Starting PolyAccess..."
echo "URL: http://localhost:3001"
echo ""

powershell.exe -Command "cd C:\\Users\\Ken\\Desktop\\clonetemplate\\server; \$env:PGHOST='localhost'; \$env:PGDATABASE='polyaccess'; \$env:PGPASSWORD='<password>'; node index.js"
