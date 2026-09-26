# Change – exactly one owner per household

Decision (Elad, 2026-09-27): one household manager is enough.
- Each household has exactly ONE `owner`. Invites from inside a household can create only `member` or `viewer` (remove the owner option from the UI and reject it in the RPC/RLS).
- MFA stays required for the owner and the super-admin only; optional for members/viewers (owner may still switch it to required for the household).
- Add "העברת ניהול" (transfer ownership): the owner picks a member → confirmation step → roles swap in one transaction. Requires aal2.
- The owner cannot leave or delete their own account while other members exist without transferring ownership first (clear Hebrew message).
- Enforce with a DB constraint (partial unique index on household_members where role = 'owner') + RLS/RPC tests: second owner rejected, transfer works, member cannot promote self, owner cannot leave without transfer.
- Update ADMIN.md (lost-MFA owner case stays: super-admin resets the factor in Supabase).
