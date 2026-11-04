# PPAP elements and a tracker model

## The 18 elements
1. Design records
2. Authorized engineering change documents
3. Customer engineering approval (when required)
4. Design FMEA (DFMEA; for design-responsible suppliers)
5. Process flow diagram
6. Process FMEA (PFMEA)
7. Control plan
8. Measurement system analysis (MSA) studies
9. Dimensional results
10. Material / performance test results
11. Initial process studies (capability, e.g. Ppk)
12. Qualified laboratory documentation
13. Appearance approval report (AAR; appearance items)
14. Sample production parts
15. Master sample
16. Checking aids
17. Customer-specific requirements records
18. Part Submission Warrant (PSW)

## Submission levels
- Level 1: PSW only (plus AAR for appearance items).
- Level 2: PSW with product samples and limited supporting data.
- Level 3: PSW with product samples and complete supporting data (the usual default).
- Level 4: PSW and other requirements as defined by the customer.
- Level 5: PSW with product samples and complete supporting data reviewed at the
  supplier's manufacturing location.

Customer requirements (for Stellantis: the CSR and supplier portal) decide the level,
triggers for resubmission and the format; check them for each program.

## Tracker model
- **PPAP Submissions** (part number, revision, supplier, program, level, reason
  for submission, due date, status, PSW signed date, customer decision).
- **PPAP Elements** (child: element number 1–18 from a lookup table, required?
  (formula from level and part type), owner, status, evidence file, reviewer, comments).
- Formula on the submission: `% Complete = [# Elements Approved] / [# Elements Required]`.
- Report: submissions by program and gate with traffic-light status; overdue elements
  by owner.
