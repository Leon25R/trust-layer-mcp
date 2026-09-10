-- Optional internal provenance for the Custom Instructions / Skill / prompt version.
ALTER TABLE assessment_event_receipts ADD COLUMN IF NOT EXISTS guidance_version text NULL;
ALTER TABLE research_manifests ADD COLUMN IF NOT EXISTS guidance_version text NULL;
