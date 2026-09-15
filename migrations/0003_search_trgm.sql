CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX versions_search_text_trgm_idx ON versions USING gin (search_text gin_trgm_ops);