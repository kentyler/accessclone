#!/usr/bin/env bash
# Helper script to connect to Windows PostgreSQL from WSL
# Usage: ./scripts/psql.sh [sql-file.sql]
#        ./scripts/psql.sh -c "SELECT 1"

export PGPASSWORD=<password>
export PGHOST=localhost
export PGUSER=postgres
export PGDATABASE=polyaccess
export PGPORT=5432

echo "Connecting to PostgreSQL at $PGHOST:$PGPORT/$PGDATABASE..."

if [ -z "$1" ]; then
    psql
elif [ "$1" = "-c" ]; then
    psql -c "$2"
elif [ -f "$1" ]; then
    psql -f "$1"
else
    psql "$@"
fi
