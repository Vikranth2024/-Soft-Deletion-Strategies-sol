# LedgerApp ΓÇö Pre-Refactor Hard Delete Audit

**Auditor:** Senior Database Engineer  
**Date:** 2026-03-18  
**Scope:** All route files in `/routes/` ΓÇö `users.js`, `accounts.js`, `transactions.js`  
**Purpose:** Identify every hard-delete query that permanently destroys financial records, assess the data destroyed, and map each to a concrete regulatory or business failure scenario.

---

## Executive Summary

Every delete operation in this codebase issues a `DELETE FROM` SQL statement that permanently removes records from the database with no recovery path. There is no `deleted_at` column, no archive table, no audit log, and no admin endpoint to retrieve removed data. For a financial record management system, this is a critical compliance violation. The following entries document each dangerous query, what it destroys, and the specific scenario where that destruction constitutes a regulatory or business failure.

---

## Audit Entry 1

**File:** `routes/users.js`  
**Approximate Line:** 45  
**Exact Query:**
```sql
DELETE FROM users WHERE id = $1
```

**Data Permanently Destroyed:**
The complete user identity record, including their name, email address, account creation timestamp, and database primary key. Once this row is gone, there is no link back to any account or transaction the user ever owned. Foreign key constraints on `accounts.user_id` will either cascade-delete all child accounts (and their child transactions) or fail with a constraint violation ΓÇö either outcome is catastrophic.

**Regulatory / Business Scenario:**
A user submits a support ticket disputing a charge and then requests account deletion the following day. The customer service team processes the deletion. Two weeks later, the user files a chargeback with their bank citing the disputed transaction. The bank requests documentary evidence that the transaction was authorised. LedgerApp cannot produce the user record, the account record, or the transaction record ΓÇö all were cascade-deleted when `DELETE FROM users WHERE id = $1` ran. Under **PCI DSS Requirement 10.7**, transaction records related to cardholder disputes must be retained. LedgerApp has no defence and loses the chargeback automatically.

---

## Audit Entry 2

**File:** `routes/users.js`  
**Approximate Line:** 43 (GET all users handler)  
**Exact Query:**
```sql
SELECT * FROM users
```

**Data Permanently Destroyed:**
No data is destroyed by this SELECT, but its absence of a `WHERE deleted_at IS NULL` filter is an audit-critical defect. Once soft delete is added, this query will silently resurface deleted users in API responses, exposing personally identifiable information (PII) for users who have exercised their right to erasure. This is documented here because the SELECT and the DELETE are inseparable defects ΓÇö fixing the DELETE without fixing the SELECT introduces a GDPR data exposure.

**Regulatory / Business Scenario:**
A user requests account deletion under **GDPR Article 17 (Right to Erasure)**. The development team adds `deleted_at` but forgets to update the SELECT. The deleted user's name and email continue appearing in internal admin dashboards and exported reports. This constitutes a GDPR violation regardless of whether the soft-delete logic is otherwise correct.

---

## Audit Entry 3

**File:** `routes/accounts.js`  
**Approximate Line:** 52  
**Exact Query:**
```sql
DELETE FROM accounts WHERE id = $1
```

**Data Permanently Destroyed:**
The account record itself ΓÇö account type (checking/savings), balance at time of deletion, the `user_id` linkage, and `created_at` timestamp. Critically, because `transactions.account_id` is a foreign key referencing `accounts.id`, this DELETE will either cascade-delete all transactions belonging to this account or fail with a constraint violation depending on the FK definition. In either case, the transaction history is at risk.

**Regulatory / Business Scenario:**
A business closes a checking account after switching banks. The account is deleted via this route. At year-end, the company's accountant requests a full ledger for the closed account to prepare IRS Form 1120 (Corporate Tax Return). The account record is gone. All transactions linked to it are either gone (cascade) or orphaned (no cascade). The company cannot produce income and expense records for that account period. Under **26 U.S.C. ┬º 6501**, the IRS can assess tax for up to three years (six years if income is understated by 25%+). The company faces penalties with no documentary defence.

---

## Audit Entry 4

**File:** `routes/transactions.js`  
**Approximate Line:** 58  
**Exact Query:**
```sql
DELETE FROM transactions WHERE id = $1
```

**Data Permanently Destroyed:**
The individual transaction record: amount, type (credit/debit), description, associated `account_id`, and creation timestamp. This is the atomic unit of financial truth in the system. Once deleted, there is no ledger entry, no audit trail, and no way to reconstruct the account's historical balance.

**Regulatory / Business Scenario:**
A bank operations analyst notices a suspicious transaction and forwards it to the compliance team for investigation. Before the compliance team opens the case, a junior engineer deletes the transaction via the admin panel, believing it was a test entry. The compliance team opens the case to find the record missing. Under **Bank Secrecy Act (BSA) / 31 U.S.C. ┬º 5318**, financial institutions are required to retain records of transactions for a minimum of five years. The missing record triggers a Suspicious Activity Report (SAR) deficiency finding. The institution faces a civil money penalty from FinCEN and a mandatory remediation programme.

---

## Audit Entry 5

**File:** `routes/transactions.js`  
**Approximate Line:** 30 (GET all transactions handler)  
**Exact Query:**
```sql
SELECT * FROM transactions WHERE account_id = $1
```

**Data Permanently Destroyed:**
No data is destroyed by this SELECT in the current state. However, there is no `deleted_at IS NULL` guard, meaning that once soft delete is implemented, "deleted" transactions will continue appearing in account balance calculations and user-facing transaction lists. This creates phantom entries on statements ΓÇö or conversely, if the SELECT is fixed without updating the balance calculation logic, the balance will diverge from the visible transaction history.

**Regulatory / Business Scenario:**
A user disputes a transaction through the app interface. Support soft-deletes the transaction. The SELECT in the transaction list now excludes it (correct). However, a legacy balance calculation routine still runs `SELECT * FROM transactions WHERE account_id = $1` without the soft-delete filter, so the account balance still reflects the disputed transaction. The user's balance display is now inconsistent with their statement. This creates a **Truth in Lending Act (TILA) / Regulation Z** disclosure failure ΓÇö the balance presented to the consumer does not match the transaction history presented to the consumer.

---

## Audit Entry 6

**File:** `routes/accounts.js`  
**Approximate Line:** 28 (GET all accounts handler)  
**Exact Query:**
```sql
SELECT * FROM accounts WHERE user_id = $1
```

**Data Permanently Destroyed:**
No data destroyed directly. Same category of defect as Entries 2 and 5 ΓÇö the SELECT has no soft-delete filter. When an account is soft-deleted, this query will return it to the client. Equally, if the client-side is never told an account is "deleted," it may continue displaying it as active, allowing users to attempt transactions against a closed account.

**Regulatory / Business Scenario:**
A savings account is soft-deleted after the user closes it. The GET accounts route still returns it to the mobile app (no `deleted_at IS NULL` filter). The mobile app displays it as an active account. The user selects it to initiate a transfer. The backend rejects the transfer (because a separate guard checks for the account's active status), but the UI shows an error with no explanation. The customer calls support. Support cannot explain why a "visible" account cannot be used. This is both a **UX failure and a potential Regulation E (Electronic Fund Transfer Act) compliance issue**, as disclosures about account status must be accurate and accessible.

---

## Summary Table

| # | File | Query | Category | Severity |
|---|------|-------|----------|----------|
| 1 | `routes/users.js` | `DELETE FROM users WHERE id = $1` | Hard Delete | **Critical** |
| 2 | `routes/users.js` | `SELECT * FROM users` | Missing Soft-Delete Filter | **High** |
| 3 | `routes/accounts.js` | `DELETE FROM accounts WHERE id = $1` | Hard Delete | **Critical** |
| 4 | `routes/transactions.js` | `DELETE FROM transactions WHERE id = $1` | Hard Delete | **Critical** |
| 5 | `routes/transactions.js` | `SELECT * FROM transactions WHERE account_id = $1` | Missing Soft-Delete Filter | **High** |
| 6 | `routes/accounts.js` | `SELECT * FROM accounts WHERE user_id = $1` | Missing Soft-Delete Filter | **High** |

---

## Cascade Risk Assessment

The most dangerous structural issue is not in any single query ΓÇö it is the unguarded foreign key chain:

```
users ΓåÆ accounts ΓåÆ transactions
```

If `accounts.user_id` has `ON DELETE CASCADE` and `transactions.account_id` has `ON DELETE CASCADE`, then a single `DELETE FROM users WHERE id = $1` silently destroys every account and every transaction that user ever had ΓÇö potentially thousands of records ΓÇö in a single database operation with no warning, no log entry, and no recovery path.

If the foreign keys do not have `ON DELETE CASCADE`, then the `DELETE FROM users` will fail with a constraint violation, leaving the application in an error state with no graceful handling. Either behaviour is unacceptable for a financial system.

The correct resolution is documented in `schema.sql` and the updated route files.
