#!/usr/bin/env bash
# Local database setup. Run once.
set -e
DB_NAME="${1:-gamedb}"
DB_USER="${2:-gameuser}"

echo "Creating database '$DB_NAME' and user '$DB_USER'..."
echo "You will be prompted for a password. Put the SAME password in .env"
echo "Never hardcode it in source."
read -rsp "Password for $DB_USER: " DB_PASS
echo

psql -U postgres <<SQL
CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
SQL

psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f schema.sql
echo "Done. Set DATABASE_URL in .env to:"
echo "  postgresql://$DB_USER:<password>@localhost:5432/$DB_NAME"
