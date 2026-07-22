/**
 * Thin bootstrap (design doc §7.7). The former ~1500-line single-page capture
 * app has been decomposed into a shared kit, an app shell + router, stores, and
 * screens (see ui/app/, ui/kit/, ui/screens/, store/). This entry just hands
 * off to the app bootstrap so `/index.html` keeps its stable entry path.
 *
 * The capture pipeline moved to ui/screens/capture.ts close to verbatim; the
 * device/onboarding flows to ui/screens/onboarding.ts + deviceSheet.ts + the
 * ConnectionManager in ui/app/state.ts.
 */

import "./app/main";
