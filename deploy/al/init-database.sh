#!/bin/sh
set -eu
# psql reads the password from the container environment without placing it in command arguments.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password KUNLUN_DB_PASSWORD
CREATE ROLE kunlun_app LOGIN PASSWORD :'app_password';
ALTER DATABASE kunlun_prod OWNER TO kunlun_app;
GRANT ALL ON SCHEMA public TO kunlun_app;
SQL
