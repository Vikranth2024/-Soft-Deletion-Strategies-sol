const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /users — return only active (non-deleted) users
// Soft-delete change: added WHERE deleted_at IS NULL to exclude records that
// have been soft-deleted. Without this filter, deleted users would appear in
// API responses — a GDPR data exposure for users who exercised right to erasure.
router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, name, email, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('GET /users error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /users/:id — return a single active user
// Soft-delete change: added AND deleted_at IS NULL so that a request for a
// soft-deleted user returns 404 (not found) rather than the deleted record.
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, name, email, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('GET /users/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /users — create a new user
// No change needed — inserts are unaffected by soft-delete logic.
// deleted_at defaults to NULL, meaning the new user is immediately active.
router.post('/', async (req, res) => {
    const { name, email } = req.body;
    if (!name || !email) {
        return res.status(400).json({ error: 'name and email are required' });
    }
    try {
        const result = await db.query(
            'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
            [name, email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Email already in use' });
        }
        console.error('POST /users error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /users/:id — update a user's name or email
// Soft-delete change: added AND deleted_at IS NULL to the WHERE clause so that
// updates cannot be applied to a soft-deleted user record. Without this, an API
// caller could modify a "deleted" user's data, which violates the principle that
// soft-deleted records are immutable historical state.
router.put('/:id', async (req, res) => {
    const { name, email } = req.body;
    if (!name && !email) {
        return res.status(400).json({ error: 'At least one of name or email is required' });
    }
    try {
        const existing = await db.query(
            'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
            [req.params.id]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const result = await db.query(
            `UPDATE users
             SET name  = COALESCE($1, name),
                 email = COALESCE($2, email)
             WHERE id = $3 AND deleted_at IS NULL
             RETURNING id, name, email, created_at`,
            [name || null, email || null, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('PUT /users/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /users/:id — soft-delete a user
// HARD DELETE REPLACED: original query was DELETE FROM users WHERE id = $1
// That permanently destroyed the user record and cascaded to accounts and transactions.
//
// Replacement: UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
//
// Reason: User records are identity anchors for all financial activity in the system.
// Destroying them destroys the chain of ownership for every account and transaction
// they ever had. This violates PCI DSS Requirement 10.7, BSA 5-year retention rules,
// and makes dispute resolution impossible. Soft deletion marks the record as inactive
// while preserving every byte of historical data.
//
// Cascade behaviour: we do NOT cascade soft-delete to accounts/transactions here.
// The application can choose to soft-delete accounts in a separate step. Transactions
// are never cascade-deleted — they are independent audit records.
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found or already deleted' });
        }
        res.json({ message: 'User deactivated', id: result.rows[0].id });
    } catch (err) {
        console.error('DELETE /users/:id error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/deleted — audit endpoint: return all soft-deleted users
// This route did not exist in the original codebase. Hard deletion made it impossible
// — there were no deleted records to retrieve. Now that records are soft-deleted,
// this endpoint is the compliance team's window into all deactivated accounts.
// Use cases: regulatory audit, fraud investigation, dispute resolution, GDPR SAR response.
// Access should be restricted to admin roles in production (auth middleware not shown here).
router.get('/admin/deleted', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, name, email, created_at, deleted_at
             FROM users
             WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC`
        );
        res.json({
            count: result.rows.length,
            deleted_users: result.rows
        });
    } catch (err) {
        console.error('GET /admin/deleted (users) error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
