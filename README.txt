LASALLIAN SYMPHONY ORCHESTRA — DUTY HOURS ONLINE RELEASE
=======================================================

This version keeps the existing online Membership + Attendance system and adds
Duty Hours tracking for the Trainee and Probationary Periods.

DUTY HOURS DATA MODEL
---------------------
The shared system_state record now includes a duty_hours JSON object containing:
- commitments: required Trainee and Probationary hours per member
- entries: rendered-duty and incentive/adjustment ledger entries

CALCULATION
-----------
Rendered Hours = total Rendered Duty entries
Net Incentive = positive and negative Incentive / Adjustment entries
Credited Hours = Rendered Hours + Net Incentive
Balance = Committed Hours - Credited Hours

A positive incentive reduces the remaining requirement. A negative adjustment
increases the remaining requirement.

ONLINE SYNCHRONIZATION
----------------------
Duty Hours uses the same Supabase shared-storage layer as members, events,
attendance, settings, and activity logs. Approved users on other devices receive
updated data through the existing cloud polling process.

BACKUPS
-------
Complete System Backup files now include the dutyHours object. Older backup files
without dutyHours can still be restored; the system creates an empty Duty Hours
ledger for them.

REQUIRED UPGRADE
----------------
Run the included supabase-setup.sql in the existing Supabase project before
publishing the website files. It adds the duty_hours column when missing and
replaces the controlled state functions without deleting current records.
