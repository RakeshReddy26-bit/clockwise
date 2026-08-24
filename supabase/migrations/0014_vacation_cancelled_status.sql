-- Clockwise · Migration 0014 · vacation_status += 'cancelled' (Phase E)
--
-- Alone in its own migration on purpose. PostgreSQL refuses to USE a newly
-- added enum value inside the transaction that added it — "unsafe use of new
-- value" — and 0015 references 'cancelled' in the employee withdrawal policy.
-- Splitting the ALTER TYPE into its own file gives it its own transaction and
-- is the standard remedy. Apply this first, then 0015.
--
-- Why the value is needed: an employee must be able to withdraw a vacation
-- request they have not had decided yet. Reusing 'rejected' would put a
-- manager's name on a decision nobody made, and deleting the row would erase
-- history the rest of this system is built to keep.

alter type public.vacation_status add value if not exists 'cancelled';
