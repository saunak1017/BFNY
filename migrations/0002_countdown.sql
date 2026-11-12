-- The countdown runs independently of the game phase. Server timestamps keep devices synchronized.
ALTER TABLE settings ADD COLUMN countdown TEXT;
