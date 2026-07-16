LASALLIAN SYMPHONY ORCHESTRA — SEMESTER OPERATIONS RELEASE
=========================================================

This release preserves the current online shared system and reorganizes
Attendance and Duty Hours into independent, semester-aware modules.

ATTENDANCE DATA
---------------
Every event may contain:
- semester: First Semester or Second Semester
- title, type, date, time, venue, and notes

Attendance analytics filter events by semester before calculating:
- Present
- Late
- Absent
- Excused
- Attendance rate
- Individual rehearsal totals and history

Legacy events without a semester are interpreted as First Semester.

DUTY HOURS DATA MODEL — VERSION 2
---------------------------------
Duty Hours stores:
- commitment minutes per member, semester, and period
- rendered-duty entries in minutes
- signed incentive adjustments in minutes

Periods:
- Trainee Period
- Probationary Period

Semesters:
- First Semester
- Second Semester

CALCULATION
-----------
Credited Time = Rendered Time + Net Incentive
Remaining Time = Committed Time - Credited Time

A positive incentive is a credit and reduces remaining time.
A negative incentive is a deduction and increases remaining time.
All calculations use whole minutes.

MIGRATION
---------
Earlier Duty Hours records used decimal hours and had no semester field.
The browser automatically converts those values to minutes and places them in
First Semester. No prior duty entry is intentionally discarded.

ONLINE SYNCHRONIZATION
----------------------
The same Supabase shared state synchronizes members, events, attendance,
duty hours, settings, and activity logs across approved devices.

BACKUPS
-------
Complete System Backup continues to include dutyHours. Download a backup before
replacing live files or running a database upgrade.


CLOCK-BASED DUTY ENTRY
----------------------
Rendered duty no longer requires manually calculating Hour and Minute. Enter the
service date, Time In, and Time Out. The application calculates Time Out minus
Time In, displays a live duration preview, and saves the result as exact minutes.
Existing manual-duration entries remain readable and are labeled Manual duration.
