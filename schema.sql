-- =============================================================================
-- LedgerApp ΓÇö Updated Schema (Soft Delete Refactor)
-- =============================================================================
-- Changes from original:
--   - Added deleted_at TIMESTAMPTZ DEFAULT NULL to users, accounts, transactions
--   - Added partial indexes on each table for active (non-deleted) rows
--   - Added foreign key indexes (missing from original schema)
--   - Cascade behaviour changed to RESTRICT to prevent silent mass-destruction
--
-- Note on deleted_at semantics:
--   NULL  ΓåÆ the record is active and visible to normal application queries
--   value ΓåÆ the record was soft-deleted at that timestamp; treat as gone for
--           all normal operations but retain for audit, compliance, and recovery
--
-- Tables that do NOT get deleted_at:
--   None in this schema. Every primary business entity here is a financial record
--   subject to regulatory retention requirements. Session tables, ephemeral cache
--   tables, or temporary processing tables (e.g. import_staging, job_queue) would
--   NOT get soft-delete columns because they contain no business state worth
--   retaining ΓÇö their purpose is transient, not historical.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- USERS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    name       TEXT        NOT NULL,
    email      TEXT        NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- deleted_at: NULL means the user account is active.
    -- A timestamp means the account was soft-deleted at that moment.
    -- Hard data deletion should NEVER occur here ΓÇö user identity records
    -- must be retained for dispute resolution, fraud investigation, and
    -- regulatory tracing even after the user closes their account.
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- Partial index: only indexes rows where the user is active (not soft-deleted).
-- Queries that filter WHERE deleted_at IS NULL benefit from this index because
-- it covers only the live working set, not the full historical table.
-- At scale, this index stays small as records accumulate ΓÇö it never grows
-- to include the ever-expanding set of soft-deleted rows.
CREATE INDEX idx_users_active ON users(id) WHERE deleted_at IS NULL;

-- Index on email for login / uniqueness checks (always needed, active only)
CREATE INDEX idx_users_email_active ON users(email) WHERE deleted_at IS NULL;


-- -----------------------------------------------------------------------------
-- ACCOUNTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER     NOT NULL,
    account_type TEXT        NOT NULL CHECK (account_type IN ('checking', 'savings')),
    balance      NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- deleted_at: NULL means this account is open and operational.
    -- A timestamp means the account was closed (soft-deleted) at that time.
    -- Closed account records must be retained to reconstruct historical balances,
    -- satisfy tax authority requests, and support chargeback evidence submission.
    deleted_at TIMESTAMPTZ DEFAULT NULL,

    -- RESTRICT (not CASCADE): a deleted user must not silently destroy accounts.
    -- The application layer must soft-delete accounts explicitly before soft-deleting
    -- the user. This forces intentional, auditable deletion sequencing.
    CONSTRAINT fk_accounts_user FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE RESTRICT
);

-- Partial index for active accounts by user ΓÇö the primary query pattern
CREATE INDEX idx_accounts_active ON accounts(id) WHERE deleted_at IS NULL;

-- Index on user_id foreign key (was missing from original schema, causes seq scans)
-- Partial: only active accounts, since listing closed accounts is an admin-only path
CREATE INDEX idx_accounts_user_active ON accounts(user_id) WHERE deleted_at IS NULL;


-- -----------------------------------------------------------------------------
-- TRANSACTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id         SERIAL PRIMARY KEY,
    account_id INTEGER        NOT NULL,
    amount     NUMERIC(15, 2) NOT NULL,
    type       TEXT           NOT NULL CHECK (type IN ('credit', 'debit')),
    description TEXT,
    created_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    -- deleted_at: NULL means this transaction appears on the account ledger.
    -- A timestamp means the transaction was removed from the user-visible ledger
    -- at that time ΓÇö but it MUST remain in the database permanently.
    -- Transaction records are subject to BSA 5-year retention, IRS 7-year retention
    -- for tax purposes, and PCI DSS cardholder dispute requirements.
    -- Deleting a transaction record is never the correct action in a financial system.
    deleted_at TIMESTAMPTZ DEFAULT NULL,

    -- RESTRICT: deleting an account must not silently destroy its transactions.
    -- The application must soft-delete transactions before soft-deleting the account,
    -- or leave them in place and rely on the account's deleted_at status to gate access.
    CONSTRAINT fk_transactions_account FOREIGN KEY (account_id) REFERENCES accounts(id)
        ON DELETE RESTRICT
);

-- Partial index for active transactions by account ΓÇö the single most-executed query
-- in the application. Without this, every transaction list query becomes a full
-- table scan as the table grows past 500,000 rows.
CREATE INDEX idx_transactions_active ON transactions(id) WHERE deleted_at IS NULL;

-- Composite partial index: account_id + active status ΓÇö covers the exact query
-- SELECT * FROM transactions WHERE account_id = $1 AND deleted_at IS NULL
CREATE INDEX idx_transactions_account_active
    ON transactions(account_id)
    WHERE deleted_at IS NULL;

-- Index for audit queries: finding all soft-deleted transactions (admin/compliance)
CREATE INDEX idx_transactions_deleted
    ON transactions(account_id)
    WHERE deleted_at IS NOT NULL;
