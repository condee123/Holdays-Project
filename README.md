# Company Holiday Tracker (starter)

Static front end for GitHub Pages + Supabase backend. **Do not deploy with placeholder config.**

## Pages
- `index.html`: name/password sign-in
- `change-password.html`: first-login password update
- `employee.html`: request leave, allowance and request history
- `admin.html`: pending approval queue and calendar preview
- `calendar.html`: shared month calendar

## Deployment outline
1. Create a Supabase project (UK region if available/appropriate) and run `supabase/schema.sql` in SQL Editor.
2. Configure `assets/config.js` with the project URL and anon key only. Never use a service-role key in browser code.
3. Create employee accounts in Supabase Auth using synthetic email addresses derived from names: lower-case name with punctuation replaced by dots + `@holiday.company.invalid`. Example `Connor Dennison` -> `connor.dennison@holiday.company.invalid`. Assign temporary passwords; create matching `profiles` and `employees` rows (see schema comments).
4. Set exactly three profiles to `role='admin'`. Link their Auth user IDs to profiles. Admins should use MFA.
5. Enable GitHub Pages for this repository (root or `/docs`) and publish.
6. Test with separate employee/admin accounts, including attempts to access other employees' data.

## Excel rules to migrate
Employee List includes employee, department, start date, allowance, carryover, team, bank-holiday accrual and long-service extra days. Team Rota 2027 defines the 4-day rotation, bank-holiday accrual and shutdown. Individual sheets are derived views. Confirm the 2027 calendar/allowances before production and plan yearly rollover.

## Important production checklist
- Configure Supabase Auth password policy, rate limits, email/identity recovery (or secure admin-issued reset), and MFA for admins.
- Keep database backups and a documented retention policy.
- Add a server-side approval function/trigger that checks balances and date overlaps atomically; do not rely on browser calculations.
- Decide whether calendar shows names, initials, or only team availability; publish only the minimum personal data.
- Add date-specific rota/bank-holiday data and calculate working days according to each employee's team. The demo client currently counts weekdays only and is not the full Excel rota engine.
- Add admin CRUD screens, audit log, export, and a proper password-reset workflow before production use.
