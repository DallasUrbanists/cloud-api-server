---
name: dallas-311-inventory
description: Complete the Dallas 311 service-request inventory in data/311 by inspecting the live public portal, mapping conditional Details-form paths, and saving one verified JSON file per service type. Use for continuing or auditing this specific inventory.
argument-hint: "[resume or audit]"
user-invocable: true
---

# Dallas 311 inventory

Complete the existing inventory at `data/311/`. The public portal is `https://dallascrm.my.site.com/public/s/`. The dataset contains 178 distinct service types, one JSON file per type. The user's agreed scope is **only observed site content** and **every distinct conditional path**, without enumerating arbitrary free-text or numeric values. Do not submit a service request or enter data on the Contact step.

## Start from the saved state

Read the user's current instructions and inspect `data/311/*.json`. Query `detailsForm.status` rather than relying on a remembered count. Expected finished statuses are `conditional_paths_explored` and `instructions_only`; revisit `not_started` and `partial`. The per-item files are authoritative. Do not rewrite the old monolithic backup.

PowerShell inventory query:

```powershell
$items = Get-ChildItem data/311 -Filter '*.json' | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json }
$items | Group-Object { $_.detailsForm.status } | Select-Object Name,Count
$items | Where-Object { $_.detailsForm.status -in @('not_started','partial') } | Select-Object title,categories,@{n='status';e={$_.detailsForm.status}}
```

Finish all unfinished items in **Water Inquiries and Line Locates**, then **Other Requests**. Revisit the partial `Complaint/Compliment` item there. Other categories were finished in earlier passes. The user requested non-stop progress until 100% or a manual stop; honor a new pause/stop request immediately. If the shared browser tab is unavailable, open the portal in the available browser and continue from the saved files.

## Capture one service type

1. Open its category and service link. Record the exact drawer title, description, photo URL(s) if shown, department, resolution estimate, and presence of **Request This Service**. Existing seeded metadata may be reused only if it still matches the observed drawer.
2. If the drawer has no online request button, record its observed instructions and mark `requestThisService: false`, `detailsForm.status: "instructions_only"`, `captureStatus: "instructions_only"`.
3. If it has the button, click it; continue past File Upload without uploading anything; use the map's default pin at Location and continue to Details. Follow the [Location recovery sequence](#location-recovery-sequence) below. Wait for Details to finish loading before reading questions.
4. Capture each question's exact wording, required flag, control type, and full option list. Select each choice that might change the form. After every selection, inspect the rendered Details step for new questions, validation alerts, instructions, service suggestions, or blocked paths. Follow new branches recursively. Use mock values only to reveal or complete form paths. A choice set with no distinct new behavior needs no combinatorial free-text testing.
5. After mapping branches, fill required fields with mock data and click Details **Continue**. Confirm the Contact step appears. Record any required Contact fields as an observation, but **enter no Contact data**. Click **Cancel** to return to the main page. A call-in or blocked branch should be captured even if another branch reaches Contact.
6. Save the single item immediately before opening another one. Preserve all seeded metadata and other agents' edits. Use `scripts/Save-311Item.ps1` for a validated atomic replacement, or an equivalent flow that validates the full JSON and title before replacing the destination. Never overwrite an item with `null`, an incomplete temporary file, or a stale aggregate dataset.

On Windows, PowerShell may refuse to run the local save helper because script execution is disabled. If so, set `Set-ExecutionPolicy -Scope Process Bypass -Force` in the **same PowerShell process** before invoking the reviewed local helper; this does not change the user's persistent policy. An equivalent inline atomic write is also acceptable. Do not let a failed helper call silently count as a saved item: reopen the destination JSON after every write and check its title, status, and question-array shape.

`detailsForm.observedQuestions` must serialize as a **JSON array directly**, such as `"observedQuestions": [{"question":"..."}]`. Do not save a wrapper object with `value` and `Count` fields; this happened in one PowerShell capture and broke consistency with the other 173 files. Each question object should include `question`, `required`, `type`, `options` when applicable, `when` for conditional visibility, and `conditionalPaths` containing observed `when`, `reveals`, `instruction`, or `suggestedService`. Prefer the existing type names `single_choice`, `multi_choice`, `select`, `free_text`, `numeric`, and `date`. A text input with numeric validation is `numeric` rather than an HTML number input. Keep unnumbered **Additional Information** in `detailsForm.additionalInformation` rather than treating it as a numbered question.

For multi-choice controls, test each option alone and any small combination that may alter conditional visibility. On the observed **Water Main Leak/Break** form, the leak-description **Other** text question appears when **Other is selected alone**, then disappears when **Odor/Smell** is also selected. Do not generalize an “Other selected” condition from a single state. Before claiming a form is complete, re-read the serialized JSON and verify `observedQuestions` is an array, each conditional `when` matches the combinations observed, and the saved path to Contact is accurate.

Finished online forms use `detailsForm.status: "conditional_paths_explored"`, `detailsForm.unexplored: null`, and `captureStatus: "details_form_conditional_paths_explored"`. Record the successful route to Contact in `completedContactPath`. If a path genuinely cannot be completed, describe the observed blocker precisely; do not label it complete while known branches remain unexplored. See a finished neighboring file for the established JSON shape.

## Browser mechanics

The site renders a service drawer (`New panel opened: Create a Service Request.`) and a five-step `SR Creation Dialog`. Category buttons open a **Select a Service Request** list. For the shared browser, the page ID was `50f940de-4afd-4f6e-9618-e08c36e4e0ce`; obtain the current page ID rather than assuming it persists. Use browser accessibility snapshots to distinguish radio groups, checkboxes, select menus, textboxes, alerts, and service suggestion overlays. Dismiss a validation alert with **OK** and a suggestion with **Keep Current** when continuing to map the current type. Do not switch to a suggested type unless it is itself the item being inventoried. The Location-to-Details transition is asynchronous: a second read may be needed after Continue.

### Location recovery sequence

The Location step can initially show only “Enter the location of the concern or select it on the map below.” **Continue** is disabled until a pin is selected. Do not treat an empty address-search result as a blocker; search is unnecessary for this inventory. On the live **Water Questions** form, the following sequence selected the default pin and reached Details:

1. Read the `SR Creation Dialog` again after the Location step loads. The map may appear on the next read with the text **Select a location**.
2. Click **Select a location** inside that dialog (for example, `dialog.getByText('Select a location').click()`). This is the map's location prompt, not its address-search box. Do not assume the default pin is already selected just because a map is visible.
3. Read the dialog again. A successful selection displays **Nearest Valid Address** and **Selected Location** (in the observed session, the default pin resolved to `2045 FEDERAL ST`). Then click **Continue** once.
4. If Continue still momentarily shows Location, read the dialog again; the transition to **Details — Step 3 of 5** is asynchronous.

If **Select a location** does not appear after the map has had time to load, reload the page once and inspect the restored dialog. Prior runs recovered the in-progress Location step this way. Try the map prompt again; if necessary, cancel and reopen the service type. If the map still fails, record the exact observed blocker without marking that item complete, continue with the other independent items in the category, and revisit it before final verification. A single Location failure is not a reason to stop the full inventory.

For automation, keep each browser operation bounded and inspect the result before the next dependent action. Avoid raw page internals or unobserved network APIs as a substitute for the user's UI-based strategy. Read site text and control labels through the browser.

## Finish and report

After each category, query statuses. At the end, require exactly 178 valid per-item JSON files and zero `not_started` or `partial` statuses. Inspect any malformed JSON or inconsistent title/status pairs before claiming 100%. Report the exact finished count, unresolved exceptions if any, and the `data/311/` folder. Do not submit the Contact step.
