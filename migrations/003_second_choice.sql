ALTER TABLE registrations ADD COLUMN secondary_game_id TEXT;
ALTER TABLE registrations ADD CONSTRAINT registrations_secondary_game_fk
  FOREIGN KEY(event_id,secondary_game_id) REFERENCES games(event_id,id)
  ON DELETE SET NULL (secondary_game_id);
ALTER TABLE registrations ADD CONSTRAINT registrations_distinct_choices
  CHECK(secondary_game_id IS NULL OR secondary_game_id <> primary_game_id);
