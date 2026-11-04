/**
 * The stage page's fixture view: the app's 3D map view (web/src/ui/mapview.ts),
 * bundled for the browser by vite.config.ts (the `virtual:stage-view` module) and
 * served at /stage/view.js. The page script finds it as `window.SplancMapView`.
 */

import { MapView } from "../../../web/src/ui/mapview";

(window as unknown as { SplancMapView: typeof MapView }).SplancMapView = MapView;
