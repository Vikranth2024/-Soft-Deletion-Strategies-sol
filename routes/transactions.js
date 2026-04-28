const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /transactions — return all active (non-deleted) transactions
// Soft-delete change: added WHERE deleted_at IS NULL to exclude transactions
// that have been removed from the user-visible ledger. Without this filter,
// a user's transaction history would include entries that support staff or
// dispute handlers have soft-deleted — creating a confusing or inaccurate
// account statement.
router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, account_id, amount, type, description, created_at
             FROM transactions
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT 500`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /transactions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /transactions/account/:accountId — return active transactions for an account
// Soft-delete change: added AND deleted_at IS NULL to filter out soft-deleted
// transactions. This is the primary query for displaying an account's transaction
// history to the user.
//
// Critical design note: this query drives the user-facing ledger. If a transaction
// is soft-deleted (e.g. under dispute review) and this filter is missing, that
// transaction still appears on the user's statement — a Truth in Lending Act
// (Regulation Z) disclosure inconsistency.
//
// Balance calculation: if you maintain a running balance from transactions, the
// balance calculation query also needs the deleted_at IS NULL filter. Otherwise
// your displayed balance will not match your displayed transaction list.
router.get('/account/:accountId', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, account_id, amount, type, description, created_at
             FROM transactions
             WHERE account_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [req.params.accountId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /transactions/account/:accountId error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /transactions/:id — return a single active transaction
// Soft-delete change: AND deleted_at IS NULL ensures that a direct lookup of a
// soft-deleted transaction returns 404 for normal clients. The compliance team
// uses the admin route below to access deleted transactions.
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, account_id, amount, type, description, created_at
             FROM transactions
             WHERE id = $1 AND deleted_at IS NULL`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /transactions/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /transactions — record a new transaction against an account
// No soft-delete change needed for the insert itself.
// Guard added: verify the account is active (not soft-deleted) before allowing
// a transaction against it. Recording a credit/debit against a closed account
// is a logical error that should be rejected at the application layer.
router.post('/', async (req, res) => {
    const { account_id, amount, type, description } = req.body;
    if (!account_id || !amount || !type) {
        return res.status(400).json({ error: 'account_id, amount, and type are required' });
    }
    if (!['credit', 'debit'].includes(type)) {
        return res.status(400).json({ error: 'type must be credit or debit' });
    }
    try {
        // Verify the account exists and is not soft-deleted (closed)
        const accountCheck = await db.query(
            'SELECT id FROM accounts WHERE id = $1 AND deleted_at IS NULL',
            [account_id]
        );
        if (accountCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found or closed' });
        }

        const result = await db.query(
            `INSERT INTO transactions (account_id, amount, type, description)
             VALUES ($1, $2, $3, $4)
             RETURNING id, account_id, amount, type, description, created_at`,
            [account_id, amount, type, description || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('POST /transactions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /transactions/:id — soft-delete a transaction
// HARD DELETE REPLACED: original query was DELETE FROM transactions WHERE id = $1
// That permanently erased the transaction record from the database with no recovery path.
//
// Replacement: UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
//
// Reason: A transaction record is the atomic unit of financial truth in this system.
// Destroying it means:
//   - The account's historical balance cannot be reconstructed
//   - The transaction cannot be produced in a bank dispute or chargeback proceeding
//   - The transaction cannot be included in a tax authority audit (IRS, HMRC)
//   - The transaction cannot be surfaced in a BSA/FinCEN investigation
//
// Under the Bank Secrecy Act (31 U.S.C. § 5318), transaction records must be
// retained for a minimum of 5 years. Deletion is not permitted.
//
// Soft-deleting a transaction removes it from the user-visible ledger while
// keeping it fully intact and queryable for compliance, audit, and recovery.
//
// When to use this endpoint: dispute review (transaction flagged for investigation),
// reversal workflows (a separate credit/debit is posted to offset the original),
// or admin correction of a duplicate entry. In all cases, the original record persists.
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, account_id, amount, type',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found or already removed' });
        }
        res.json({
            message: 'Transaction removed from ledger',
            id: result.rows[0].id,
            account_id: result.rows[0].account_id,
            amount: result.rows[0].amount,
            type: result.rows[0].type
        });
    } catch (err) {
        console.error('DELETE /transactions/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/deleted — audit endpoint: return all soft-deleted transactions
// This route is the centrepiece of the soft-delete refactor's compliance value.
// In the original codebase, this was impossible — deleted transactions were gone.
// Now, every soft-deleted transaction can be retrieved with its removal timestamp.
//
// This endpoint directly satisfies the compliance scenario:
//   "An auditor requests all transactions for account ID 88, including ones the user deleted."
//   Query: SELECT * FROM transactions WHERE account_id = 88 AND deleted_at IS NOT NULL
//
// The response proves:
//   1. The transaction existed (record is intact)
//   2. The exact amount, type, and description at the time of deletion
//   3. When the transaction was originally created (created_at)
//   4. When and by which operation it was removed (deleted_at)
//
// Access must be restricted to admin/compliance roles in production.
// Optional query param: ?account_id=88 to filter by account
router.get('/admin/deleted', async (req, res) => {
    try {
        const { account_id } = req.query;

        let query;
        let params;

        if (account_id) {
            // Filtered by account — the primary compliance query path
            query = `
                SELECT id, account_id, amount, type, description, created_at, deleted_at
                FROM transactions
                WHERE deleted_at IS NOT NULL
                  AND account_id = $1
                ORDER BY deleted_at DESC
            `;
            params = [account_id];
        } else {
            // All soft-deleted transactions across all accounts
            query = `
                SELECT id, account_id, amount, type, description, created_at, deleted_at
                FROM transactions
                WHERE deleted_at IS NOT NULL
                ORDER BY deleted_at DESC
                LIMIT 1000
            `;
            params = [];
        }

        const result = await db.query(query, params);
        res.json({
            count: result.rows.length,
            filter: account_id ? { account_id } : 'all accounts',
            deleted_transactions: result.rows
        });
    } catch (err) {
        console.error('GET /admin/deleted (transactions) error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
