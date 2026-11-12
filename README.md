# Company Site: Holiday Tracker + Timesheet Log (Firebase edition)

Static site for GitHub Pages + Firebase Authentication + Cloud Firestore. All data comes from `Company_Holiday_Tracker.xlsx` via the one-time setup button on the sign-in page.

## Timesheet Log (new)
Sign in on `index.html`, then `home.html` offers **Holiday Tracker** or **Timesheet Log**. Both use the same logins.

| File | Purpose |
|---|---|
| `home.html` | Project chooser. Timesheet Log is greyed out for anyone not on the timesheet list; admins always see everything |
| `timesheet.html` | Employee weekly timesheet (Mon-Sun), saved automatically as they type, then Save & submit |
| `timesheet-admin.html` | Admin: status of everyone expected to fill in a timesheet, review and approve each job, edit the Assigned by / Van reg drop-downs, week 1 date |
| `timesheet-people.html` | Admin: tick who is expected to fill in timesheets (this also controls who can open the project) |
| `assets/timesheet.js` | All Timesheet Log logic (needs `assets/app.js` too) |

- **Week numbers** follow the tax year: week 1 is the Monday-to-Sunday week containing 1 April. An admin can change the week 1 date on the review page.
- **Statuses**: Not completed (nothing entered), Partially complete (saved draft), Filled in (submitted), In review (admin opened it, not every job ticked) and Approved (every job ticked).
- **Hours** = To minus From, shown as decimals (15 min = 0.25, 30 = 0.5, 45 = 0.75). A job that runs past midnight counts as the next day.
- **Locking**: employees can edit while a timesheet is a draft or submitted. Once an admin opens it for review it is locked. "Send back to employee" unlocks it.
- New Firestore collection `timesheets` (`{uid}_{weekStart}`), new `settings/timesheet` document, and a `timesheetRequired` flag on each employee. Republish `firestore.rules`.

## Files
| File | Purpose |
|---|---|
| `index.html` | Sign-in (name dropdown) + one-time setup button |
| `change-password.html` | First-login password change |
| `employee.html` | My allowance, request leave, my requests, recorded leave |
| `calendar.html` | Shared calendar with the 4-day-week rota, bank holidays, shutdown, leave |
| `admin.html` | Approval queue with a who-is-off calendar and a list of clashes for each request |
| `employees.html` | Editable employee table (saved back to Firestore), Christmas shutdown dates, add employee, make admin |
| `holiday-log.html` | Quick-entry log (annual leave, sick, public holiday, unpaid, other) |
| `assets/seed-data.js` | Employees, rota, bank holidays and settings extracted from the workbook |
| `firestore.rules` | Security rules (publish these **before** running setup) |

## Setup (in this order)
1. Firebase console → **Authentication → Sign-in method**: enable **Email/Password**.
2. **Firestore Database**: create it, then **Rules** → paste `firestore.rules` → **Publish**.
3. **Authentication → Settings → Authorized domains**: add `<your-username>.github.io`.
4. Upload this folder to GitHub and enable Pages.
5. Open the site, expand **First-time setup**, click **Create database & users**. Run it straight away, before sharing the link: the first person to run it becomes the admin.
6. Sign in as `Admin` / `000000`, choose a new password, then delete the `<details class="setup">` block from `index.html`.

Everyone else signs in with their full name and `000000`, and is made to pick a new password (10+ characters) first.

## Firestore collections created by setup
| Collection | Contents |
|---|---|
| `profiles/{uid}` | displayName, role, mustChangePassword |
| `employees/{uid}` | displayName, initials, department, team, startDate, allowanceDays, carryoverDays, accrualDays, longServiceDays |
| `rotaDays/{yyyy-mm-dd}` | 365 days of 2027: team1Off, team2Off, bankHoliday, label, team1Accrued, team2Accrued, companyShutdown |
| `bankHolidays/{yyyy-mm-dd}` | The 8 bank holidays |
| `settings/company` | Holiday year, allowances, accrual per team, rotation start, shutdown dates, leave types |
| `holidayLog/{id}` | Admin-entered leave and sickness (the workbook's Holiday Log) |
| `birthdayUse/{uid_year}` | One document per employee per holiday year once the birthday day is used (stops a second use; deleted if the request is rejected) |
| `loginDirectory/{uid}` | Display names only, publicly readable, feeds the sign-in dropdown (kept in sync when an admin opens the Employees page) |
| `holidayRequests/{id}` | Requests from the site (created when someone submits one) |
| `calendarEntries/{requestId}` | Initials + dates only, for the shared calendar |

## How the workbook rules are applied
- **Entitlement** = annual allowance + carryover + bank holiday accrual + long service (same as *Total Available*).
- **Days used**: Annual Leave entries in the holiday log plus approved requests, within the holiday year in `settings/company`.
- **Working days** for a request skip weekends, bank holidays, the Christmas shutdown and the person's own rest day (Team 1 / Team 2 from the rota).
- **Bradford Factor** = S² × D from Sick Leave log entries, using the workbook's amber/orange/red bands (45 / 100 / 900).
- **Initials** are two letters, extended where two people would clash (Daniel Watt `DWa`, Darren Wilkinson `DWi`, Madison Coyle `MCoy`, Mark Conroy `MCon`).

## Files that must exist in the repository (exact names, all in the same folder)
`index.html`, `change-password.html`, `employee.html`, `calendar.html`, `admin.html`, `employees.html`, `holiday-log.html`, and an `assets/` folder containing `app.js`, `config.js`, `seed-data.js`, `style.css`.
Each page checks it has the right content and shows a red banner if, for example, `holiday-log.html` contains the employees page.

After uploading, hard-refresh (Ctrl+F5, or clear the site's cache) so the browser does not keep old copies of `app.js`.

## Christmas shutdown and birthday day
- **Shutdown**: an admin enters two date ranges on the Employees page (2026–2027 and 2027–2028). Working days inside them that fall in the holiday year come off every employee's allowance, except weekends, bank holidays and the team's own rest day. Employees cannot book leave on shutdown days.
- **Birthday day**: a checkbox on the booking form, once per holiday year. One of the requested days is covered by it, so one day less comes off the allowance. It is greyed out once used and freed again if the request is rejected.

## Office TV login
On the Employees page an admin presses **Create the Calendar login**. This makes a read-only sign-in called `Calendar` (password 000000, role `display`, no forced password change). It can only open the calendar page, which shows 1, 2, 3, 4, 6 or 12 months from the current month, remembers the choice in that browser and refreshes itself every 5 minutes. No rules change is needed.

## Notes
- The sign-in dropdown lists names from `loginDirectory`, which anyone with the site address can read. It contains names only. If the list is empty or cannot load, the page falls back to typing a name or email.
- Name-based logins use a made-up email (`connor.dennison@holiday.company.invalid`), which cannot receive reset emails. Give anyone likely to forget their password a real login email on the Employees page.
- Balance checks run in the browser, not on the server.
- Requests are limited to the holiday year in `settings/company` (2027). Edit that document in the Firestore console to roll over.
- Setup is safe to re-run: existing employees are skipped.
