const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /accounts — return all active accounts
// Soft-delete change: added WHERE deleted_at IS NULL to exclude closed accounts
// from normal API responses. Without this, a user listing their accounts would
// see accounts they have already closed — creating a confusing and potentially
// misleading view of their financial state.
router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, user_id, account_type, balance, created_at
             FROM accounts
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /accounts error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /accounts/user/:userId — return active accounts for a specific user
// Soft-delete change: added AND deleted_at IS NULL to exclude closed accounts.
// This is the query path used by the mobile/web client to display a user's
// account list. Returning closed accounts here would allow the UI to display
// accounts the user can no longer transact on — a Regulation E disclosure failure.
router.get('/user/:userId', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, user_id, account_type, balance, created_at
             FROM accounts
             WHERE user_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /accounts/user/:userId error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /accounts/:id — return a single active account
// Soft-delete change: added AND deleted_at IS NULL so that a request for a
// closed account returns 404 rather than the historical record. Historical
// records are accessible only through the admin/audit route below.
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, user_id, account_type, balance, created_at
             FROM accounts
             WHERE id = $1 AND deleted_at IS NULL`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /accounts/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /accounts — open a new account for a user
// No soft-delete change needed. deleted_at defaults to NULL (active).
// Guard added: verify the user exists and is not soft-deleted before opening
// an account for them. An account tied to a deactivated user is an orphan.
router.post('/', async (req, res) => {
    const { user_id, account_type } = req.body;
    if (!user_id || !account_type) {
        return res.status(400).json({ error: 'user_id and account_type are required' });
    }
    if (!['checking', 'savings'].includes(account_type)) {
        return res.status(400).json({ error: 'account_type must be checking or savings' });
    }
    try {
        // Verify the user is active before creating an account for them
        const userCheck = await db.query(
            'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
            [user_id]
        );
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found or deactivated' });
        }

        const result = await db.query(
            `INSERT INTO accounts (user_id, account_type)
             VALUES ($1, $2)
             RETURNING id, user_id, account_type, balance, created_at`,
            [user_id, account_type]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('POST /accounts error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /accounts/:id — soft-delete (close) an account
// HARD DELETE REPLACED: original query was DELETE FROM accounts WHERE id = $1
// That permanently destroyed the account record and all its transaction history
// via cascade (if configured) or produced a FK constraint error (if not).
//
// Replacement: UPDATE accounts SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
//
// Reason: Account closure is a business event, not a data erasure event. The
// account record must persist to:
//   - Reconstruct historical balances for tax filings (IRS 7-year rule)
//   - Provide documentation in chargeback and dispute proceedings (PCI DSS)
//   - Satisfy bank regulators requesting account history on a closed account
//
// Transactions linked to this account are NOT cascade-deleted. They remain
// under their own deleted_at status. An account being closed does not mean
// its transaction history should disappear — the two lifecycles are independent.
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'UPDATE accounts SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, account_type',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found or already closed' });
        }
        res.json({
            message: 'Account closed',
            id: result.rows[0].id,
            account_type: result.rows[0].account_type
        });
    } catch (err) {
        console.error('DELETE /accounts/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/deleted — audit endpoint: return all soft-deleted (closed) accounts
// This route did not exist in the original codebase. Without soft delete, there
// was no such thing as a closed account record — it was simply gone.
// This endpoint serves compliance, audit, and tax authority requests for
// documentation on closed accounts. It returns the closing timestamp (deleted_at)
// which establishes exactly when the account was closed — critical for dispute
// resolution and regulatory timelines.
// Access should be restricted to admin roles in production (auth middleware not shown).
router.get('/admin/deleted', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, user_id, account_type, balance, created_at, deleted_at
             FROM accounts
             WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC`
        );
        res.json({
            count: result.rows.length,
            closed_accounts: result.rows
        });
    } catch (err) {
        console.error('GET /admin/deleted (accounts) error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
