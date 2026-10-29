#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password KUNLUN_DB_PASSWORD
CREATE ROLE kunlun_test_app LOGIN PASSWORD :'app_password';
ALTER DATABASE kunlun_test OWNER TO kunlun_test_app;
GRANT ALL ON SCHEMA public TO kunlun_test_app;
SQL
