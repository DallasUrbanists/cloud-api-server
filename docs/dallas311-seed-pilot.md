# Dallas 311 seed pilot review

This is an offline implementation review of the generated manifest against saved captures. It does not confirm current City policy and does not approve catalog publication. The checked-in manifest intentionally has an empty `review.approvedKeys` list and `review.pilotReviewed: false`.

| Example | Conversion checked | Result |
| --- | --- | --- |
| Routine pothole, online | Keeps the three-by-three-foot scope, nonhazardous condition, street/alley location, driveway exclusion, and separate urgent phone route. | Eligible review draft. |
| Hazardous pothole, phone | Merges the hazardous service and routine form's hazardous branch; preserves both explanations and the immediate-assistance instruction in evidence. Uses the same Dallas 311 recipient and telephone route. | Eligible review draft; separate from routine submission. |
| Atmos Energy, external contact | Keeps the captured phone number, natural-gas purpose, sewer-odor exclusion, and City capture as source. Does not invent a utility website. | Eligible review draft. |
| Animal Confined, informational guidance | Retains the saved pet-owner-surrender guidance route as an informational action rather than claiming it submits an appointment request. | Eligible review draft. |
| Natural-gas emergency, 911 | Keeps the explicit emergency condition and the saved 911 route separate from the utility contact. | Eligible review draft. |
| 311 Event Request, held | Question 10 cites conflicting response times. The record-level policy holds this action even though the candidate text does not promise either time. | Correctly blocked from import pending clarification. |

The exact stable keys for these examples are in `pilotKeys` in the manifest. Staff should review each example's `input`, `members[].originalAction`, `members[].observations`, and hold reasons. The eligible pilot has five candidate groups and six source actions because hazardous potholes consolidate two captures.

Additional regression scenarios cover new versus replacement sidewalks, the red-bulb condition requiring fewer than two visible signal heads in the same direction of travel, pet-surrender versus hazard calls sharing 311, and unresolved obstruction/utility-cut/alley-routing conflicts. These remain source-specific recommendations unless an explicit mapping decision establishes equivalence.

Before bulk import, import and inspect the current pilot revisions, record your content review in the manifest, and inspect the import report for legacy overlaps and failures. Catalog approval remains a separate staff decision. See the [seed workflow](recommendable-actions.md#dallas-311-one-time-seed) for commands and resuming interrupted imports.
