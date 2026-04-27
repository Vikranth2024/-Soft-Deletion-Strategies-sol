# LedgerApp — Evaluator Notes

**For use by:** Challenge mentors and senior reviewers  
**Purpose:** Define the full-marks standard, the most common partial-credit mistake, and the specific distinguishing check for each of the four rubric criteria.

---

## Rubric Criterion 1: Schema Correctness

### What a Full-Marks Submission Looks Like

The schema includes `deleted_at TIMESTAMPTZ DEFAULT NULL` on all three tables — `users`, `accounts`, and `transactions`. The DEFAULT NULL is explicit (not implied), and the column uses `TIMESTAMPTZ` (timezone-aware), not `TIMESTAMP` (timezone-naive). Foreign keys are updated from `ON DELETE CASCADE` to `ON DELETE RESTRICT` (or at minimum, the submission acknowledges and addresses the cascade risk). The submission includes correct partial indexes for all three tables:

```sql
CREATE INDEX idx_users_active ON users(id) WHERE deleted_at IS NULL;
CREATE INDEX idx_accounts_user_active ON accounts(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_transactions_account_active ON transactions(account_id) WHERE deleted_at IS NULL;
```

The student can explain what `DEFAULT NULL` semantics mean (NULL = active, value = deleted) and why `TIMESTAMPTZ` is preferred over `TIMESTAMP` for audit fields (regulatory records must have unambiguous timezone context — a bank's audit trail cannot use timezone-naive timestamps because the financial event's legal jurisdiction matters).

### Most Common Partial-Credit Mistake

Using `BOOLEAN DEFAULT FALSE` (is_deleted) instead of a timestamp column. This is a surface-level compliance fail: a boolean records *that* a record was deleted but not *when*. A regulatory audit requires the deletion timestamp. The question "when was this transaction removed?" cannot be answered from a boolean. Identify this in the diff by looking for `is_deleted`, `active`, or `deleted BOOLEAN` in the schema.

### Specific Distinguishing Check

Ask: **"If a regulator asks you when a user's account was deleted, how does your schema answer that question?"** A full-marks student will point to `deleted_at` and say it contains the exact UTC timestamp of deletion. A partial-credit student with `is_deleted BOOLEAN` cannot answer — their schema proves deletion occurred but not when. The timestamp is not optional; it is the entire point.

---

## Rubric Criterion 2: Query Updates

### What a Full-Marks Submission Looks Like

Every `SELECT` query in all three route files has been updated with `WHERE deleted_at IS NULL` (or `AND deleted_at IS NULL` where a WHERE clause already exists). Every `DELETE FROM` statement has been replaced with `UPDATE ... SET deleted_at = NOW()`. The `AND deleted_at IS NULL` guard is also present on the `UPDATE` statement itself — without it, a second call to `DELETE /users/5` would silently succeed even though the user was already soft-deleted (idempotency bug). Correct pattern:

```sql
UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL
```

If `result.rows.length === 0` returns true, the handler returns 404 — either the record doesn't exist, or it was already deleted. Both are correct outcomes.

Each route file also contains a `GET /admin/deleted` endpoint that queries `WHERE deleted_at IS NOT NULL`. The admin endpoint in `transactions.js` supports an optional `?account_id=88` query parameter for filtered compliance queries.

### Most Common Partial-Credit Mistake

Updating the `DELETE` routes but not the `SELECT` routes. This is extremely common and represents a fundamental misunderstanding of what soft delete requires. The student updates the delete handler correctly:

```sql
UPDATE users SET deleted_at = NOW() WHERE id = $1
```

But leaves the GET all handler as:
```sql
SELECT * FROM users
```

This means deleted users immediately appear in `/users` API responses. Identify this in the diff by checking every `SELECT` statement in all three route files against `deleted_at IS NULL`. If any SELECT is missing the filter, it is a partial-credit submission.

### Specific Distinguishing Check

Check the `GET /:id` route (single record lookup by primary key). A full-marks submission adds `AND deleted_at IS NULL` here too. A partial-credit submission often adds the filter to the `GET /` (list all) route but forgets the single-record lookup. The consequence: a client can retrieve a soft-deleted record by ID, which breaks the expected 404 behaviour and potentially exposes deleted data through direct URL access.

---

## Rubric Criterion 3: Index and Performance Analysis

### What a Full-Marks Submission Looks Like

The submission includes partial indexes — not plain indexes — on the foreign key columns with the `WHERE deleted_at IS NULL` predicate. The difference is explained and justified: a plain index grows with every row ever inserted; a partial index grows only with the active working set and stays small as soft-deleted rows accumulate. The student produces a quantified analysis that includes:

- Estimated table size at 12 months (row count × estimated row size)
- The query plan difference between a full table scan and a partial index scan (using EXPLAIN ANALYZE output or a manually constructed cost comparison)
- A clear explanation of why `Seq Scan` cost scales with total row count while partial index cost scales only with active row count

The analysis names specific numbers — not "it gets slower" but "at 500,000 rows, a full table scan touches 500,000 rows to return 200 results; the partial index touches 200."

### Most Common Partial-Credit Mistake

Creating plain indexes instead of partial indexes:

```sql
-- Partial credit (plain index)
CREATE INDEX idx_transactions_account ON transactions(account_id);

-- Full marks (partial index)
CREATE INDEX idx_transactions_account_active ON transactions(account_id) WHERE deleted_at IS NULL;
```

The plain index is not wrong — PostgreSQL will use it for the `account_id = $1` part of the query. But it does not exclude soft-deleted rows from the index, so it grows proportionally with the full table, and PostgreSQL still applies the `deleted_at IS NULL` filter as a post-index step. The partial index eliminates that step entirely.

Identify this mistake by looking for `WHERE deleted_at IS NULL` at the end of the `CREATE INDEX` statement. If it's absent, it is a partial index missing — partial credit.

### Specific Distinguishing Check

Ask: **"Why is your index still efficient five years from now when 95% of the table is soft-deleted?"** A full-marks student will explain that their partial index only contains active rows, so as soft-deleted rows accumulate, the index stays the same size (stable working set). A student with a plain index cannot give this answer — their index grows linearly with the full table regardless of soft-delete accumulation.

---

## Rubric Criterion 4: TRADEOFFS.md

### What a Full-Marks Submission Looks Like

The document contains three distinct sections, each with specific, named content:

**When Soft Delete is Correct:** Two LedgerApp-specific scenarios. Each names a specific regulation or rule by name (e.g. PCI DSS Requirement 10.7, Bank Secrecy Act 31 U.S.C. § 5318, IRS 26 U.S.C. § 6501, GDPR Article 17). Generic statements like "for compliance reasons" do not count — the regulation must be named and accurately described.

**When Hard Delete is Appropriate:** One specific scenario where soft deletion adds no value. The scenario names the specific data type (e.g. import staging rows, ephemeral session tokens, temporary job queue entries), explains why that data has no retention value independently, and describes the clean-up process. A submission that says "GDPR right to erasure" here is incorrect — that is not an appropriate hard-delete scenario for LedgerApp's financial records.

**Compliance Scenario:** The exact SQL query to satisfy the auditor's request for account 88's full transaction history including deleted records. The query must not contain `deleted_at IS NULL` — the point is to retrieve everything, regardless of deletion status. The explanation of what the output proves must include at least three distinct points: completeness, timing, and reconstructibility.

### Most Common Partial-Credit Mistake

The compliance scenario SQL query contains `WHERE deleted_at IS NULL`, which is the exact opposite of what the auditor needs. This is a fundamental reversal error — the student has correctly implemented soft delete everywhere else but then writes a compliance query that uses the same active-record filter, thereby hiding the very records the auditor is requesting.

The correct query is:
```sql
SELECT * FROM transactions WHERE account_id = 88  -- no deleted_at filter
```
or with both statuses explicitly surfaced:
```sql
SELECT *, CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS status
FROM transactions WHERE account_id = 88
```

Identify this mistake by reading the SQL in the compliance scenario section and checking whether `deleted_at IS NULL` appears. If it does, the student has not understood the purpose of the exercise.

### Specific Distinguishing Check

Ask the student: **"Your audit query returns a soft-deleted transaction. What does that record prove to the regulator that a hard-deleted transaction cannot?"** A full-marks student will articulate three distinct facts: (1) the transaction existed with a specific amount and description, (2) it was removed at a specific timestamp, and (3) the relationship between the transaction and the account is preserved through the intact `account_id` foreign key. A student who says "it shows the transaction was deleted" has only articulated one fact and has not demonstrated understanding of the regulatory value of complete, timestamped, relationship-intact record retention.
