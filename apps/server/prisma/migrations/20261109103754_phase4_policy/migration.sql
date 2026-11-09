-- AlterTable
ALTER TABLE "PolicyVersion" ADD COLUMN     "assumptions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "editedManually" BOOLEAN NOT NULL DEFAULT false;

-- The immutability guard must cover the new content columns too, otherwise a
-- confirmed policy's assumptions/edit flag could be changed after the fact.
CREATE OR REPLACE FUNCTION leash_policy_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'DRAFT' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'leash: PolicyVersion % is % and cannot be deleted', OLD."id", OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED'
     AND NEW."userId" = OLD."userId"
     AND NEW."version" = OLD."version"
     AND NEW."sourceText" = OLD."sourceText"
     AND NEW."compiledRules" = OLD."compiledRules"
     AND NEW."rulesHash" = OLD."rulesHash"
     AND NEW."compilerModel" = OLD."compilerModel"
     AND NEW."promptVersion" = OLD."promptVersion"
     AND NEW."unmappedClauses" = OLD."unmappedClauses"
     AND NEW."assumptions" = OLD."assumptions"
     AND NEW."editedManually" = OLD."editedManually"
     AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'leash: PolicyVersion % is % and immutable', OLD."id", OLD."status"
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
