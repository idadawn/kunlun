#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password REVIEW_DB_PASSWORD
CREATE ROLE kunlun_review_app LOGIN PASSWORD :'app_password';
ALTER DATABASE kunlun_review OWNER TO kunlun_review_app;
GRANT ALL ON SCHEMA public TO kunlun_review_app;
SQL
