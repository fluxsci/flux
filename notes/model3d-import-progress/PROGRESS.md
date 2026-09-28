# Import preparation feedback

Base: `5369cdc9`; isolated branch `model3d-import-progress`.

Implemented shared one-shot 1000ms status at the native import await. One operation
owns each registry token; owner changes and settlement dispose timers/subscriptions.
No preparation delay, RAF, polling, percentage or mutation of import/adoption policy.

Reviewed production source: core agent approved; retained previous broad path mapping
instead of introducing a narrower first-match rule. Awaiting actual GUI qualification
and independent final gates. Pure feedback11 checks passed17-44-43-098Z-2;
changed-pathmap passed17-44-13-051Z-2. No native renderer run for this change.

Final qualification: own group2/2 (11 pure + 11 GUI) passed17-47-50-161Z-2;
independent core2/2 passed17-48-43-758Z-1446154 with sourceChanged=false,
digest1e77bbaf60207209967a5774c83602d432a79b924d01eb3e3182254d4010305e.
Both screenshots personally inspected by author and reviewer: actual filenames readable,
sibling rejection preserves the pending status and existing mesh. Existing import group5/5
passed17-48-25-794Z-2. npm run check:0 errors/0 warnings; check:headless passed.
No renderer/native product or binary transport changes. Final post-freeze edits only
this receipt and guide qualification wording. All tests use scratch HOME/XDG.
