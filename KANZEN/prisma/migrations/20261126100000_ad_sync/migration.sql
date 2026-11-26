-- Synchronisation AD : origine de la désactivation d'un compte (AD_SYNC = automatique, réversible)
ALTER TABLE "User" ADD COLUMN "disabledReason" TEXT;
