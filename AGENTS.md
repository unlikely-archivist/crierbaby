# Project correction checks

- Do not claim a responsive or visual layout fix is complete based only on static code inspection or passing unit tests. Verify the affected screen in a real browser at the target mobile viewport and at desktop preview width. If browser rendering is unavailable, say so and do not make structural positioning changes to `header`, `main`, or `nav` without user-visible verification.
- Keep portfolio framing separate from the application layout. A desktop phone frame must wrap or embed the mobile app without changing the production app's fixed/sticky positioning rules.
